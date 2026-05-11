'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  EFFORT_PRESETS,
  EFFORT_TIERS,
  DEFAULT_EFFORT,
  resolveEffortTier,
} = require('../../agent/effort');

class WebSettingsService {
  constructor(gateway) {
    this.gateway = gateway;
  }

  get config() { return this.gateway.config; }
  get log() { return this.gateway.log; }
  get tools() { return this.gateway.tools; }
  get graph() { return this.gateway.graph; }

  readSettingsConfigFile() {
    const settings = require('../../settings');
    return settings.snapshot();
  }

  writeSettingsConfigFile(_nextConfig) {
    this.log.debug('[settings] _writeSettingsConfigFile is a no-op; use transport.applyPatch');
  }

  applyEnvUpdates(envUpdates = {}) {
    const settings = require('../../settings');
    const allDefs = settings.allDefs();
    const patch = {};
    let unmapped = 0;

    for (const [envName, value] of Object.entries(envUpdates || {})) {
      const def = allDefs.find(d => d.envVar === envName || (d.legacyAlias || []).includes(envName));
      if (!def) { unmapped++; continue; }
      patch[def.key] = (value === null || value === undefined || value === '') ? null : value;
    }

    if (unmapped) this.log.debug(`[settings] applyEnvUpdates: ${unmapped} unmapped env name(s) ignored`);
    if (!Object.keys(patch).length) return;

    try {
      settings.applyPatch(patch, { actor: 'web:legacy-env-update' });
      this.mirrorSettingsToLegacyConfig();
    } catch (e) {
      this.log.warn(`[settings] applyEnvUpdates patch failed: ${e?.message}`);
    }
  }

  deriveDisplayName(agentId) {
    return (agentId || 'spore')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  normalizeSettingsModelRef(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return { raw: '', provider: 'anthropic', model: '' };
    const slash = raw.indexOf('/');
    if (slash <= 0) return { raw, provider: 'anthropic', model: raw };
    return {
      raw,
      provider: raw.slice(0, slash).trim().toLowerCase() || 'anthropic',
      model: raw.slice(slash + 1).trim(),
    };
  }

  composeSettingsModelRef(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || null;
    }
    const provider = String(value.provider || 'anthropic').trim().toLowerCase() || 'anthropic';
    const model = String(value.model || value.name || '').trim();
    if (!model) return null;
    return provider === 'anthropic' ? model : `${provider}/${model}`;
  }

  currentCustomProviderNames() {
    const names = new Set(Object.keys(this.config.customProviders || {}));
    if (!this.config.customProviders?.local && this.config.localModelBaseUrl) names.add('local');
    const providerRe = /^SPORE_PROVIDER_([A-Z0-9_]+)_(URL|KEY|AUTH_HEADER)$/;
    for (const key of Object.keys(process.env)) {
      const m = key.match(providerRe);
      if (m) names.add(m[1].toLowerCase());
    }
    return [...names];
  }

  _legacyLocalAsCustomProvider() {
    if (this.config.customProviders?.local || !this.config.localModelBaseUrl) return null;
    return {
      name: 'local',
      url: this.config.localModelBaseUrl || '',
      key: '',
      keySet: !!this.config.localModelApiKey,
      authHeader: this.config.localModelAuthHeader || 'bearer',
      legacyLocal: true,
    };
  }

  _customProvidersForState() {
    const rows = Object.entries(this.config.customProviders || {})
      .map(([name, provider]) => ({
        name,
        url: provider?.url || '',
        key: '',
        keySet: !!provider?.key,
        authHeader: provider?.authHeader || 'bearer',
      }));
    const legacyLocal = this._legacyLocalAsCustomProvider();
    if (legacyLocal) rows.push(legacyLocal);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  normalizeSettingsCustomProviders(rawProviders) {
    const mgr = this.tools?._pluginManager;
    const builtins = new Set(
      (mgr?.getProviders?.() || [])
        .map(p => String(p.name || '').toLowerCase())
        .filter(Boolean)
    );
    const existingCustom = new Set(Object.keys(this.config.customProviders || {}).map(name => String(name).toLowerCase()));
    const providers = [];
    const seen = new Set();

    for (const entry of Array.isArray(rawProviders) ? rawProviders : []) {
      const name = String(entry?.name || '').trim().toLowerCase();
      if (!name) continue;
      if (builtins.has(name) && !existingCustom.has(name)) {
        throw new Error(`Custom provider "${name}" conflicts with a built-in provider name`);
      }
      if (!/^[a-z0-9_-]+$/.test(name)) {
        throw new Error(`Custom provider "${name}" must use lowercase letters, numbers, underscores, and hyphens only`);
      }
      if (seen.has(name)) continue;
      seen.add(name);
      providers.push({
        name,
        url: String(entry?.url || '').trim(),
        key: String(entry?.key || '').trim(),
        authHeader: String(entry?.authHeader || 'bearer').trim() || 'bearer',
      });
    }

    return providers;
  }

  normalizeBrowserBackendSetting(rawValue) {
    const raw = String(rawValue || '').trim().toLowerCase();
    if (!raw || raw === 'zd') return 'zendriver';
    if (raw === 'pw') return 'playwright';
    if (!['zendriver', 'playwright'].includes(raw)) {
      throw new Error(`Unknown browser backend "${rawValue}". Use zendriver or playwright.`);
    }
    return raw;
  }

  getSettingsState() {
    const fileConfig = this.readSettingsConfigFile();
    const envDisplay = !!process.env.SPORE_DISPLAY_NAME;
    const envNicknames = !!process.env.SPORE_NICKNAMES;
    const envVoice = [
      'SPORE_VOICE_ENABLED',
      'SPORE_STT_PROVIDER',
      'SPORE_TTS_PROVIDER',
      'SPORE_TTS_VOICE',
      'SPORE_TTS_MODEL',
      'SPORE_TTS_EDGE_VOICE',
    ].some(k => !!process.env[k]);
    const envProactive = [
      'SPORE_PROACTIVE_ENABLED',
      'SPORE_PROACTIVE_COOLDOWN',
      'SPORE_PROACTIVE_MAX_DAY',
      'SPORE_PROACTIVE_CHANNELS',
    ].some(k => !!process.env[k]);

    const mgr = this.tools?._pluginManager;
    const voiceProviders = (mgr?.getSTTProviders?.() || []).map(p => ({
      name: p.name,
      pluginId: p.pluginId,
      configured: p.configured,
    }));
    const sttConfigured = voiceProviders.some(p => p.configured);
    const pipeline = this.gateway._ensureVoicePipeline();
    const customProviders = this._customProvidersForState();

    return {
      identity: {
        agentId: this.config.agentId,
        displayName: this.config.displayName || this.deriveDisplayName(this.config.agentId),
        nicknames: Array.isArray(this.config.nicknames) ? this.config.nicknames : [],
      },
      memory: {
        enhancedRecall: !!this.config.enhancedRecall,
      },
      proactive: {
        enabled: !!this.config.proactive?.enabled,
        cooldownMinutes: Number(this.config.proactive?.cooldownMinutes || 60),
        maxPerDay: Number(this.config.proactive?.maxPerDay || 5),
        channels: Array.isArray(this.config.proactive?.channels) ? this.config.proactive.channels : [],
      },
      voice: {
        enabled: !!this.config.voice?.enabled,
        sttProvider: this.config.voice?.sttProvider || (voiceProviders.find(p => p.configured)?.name || ''),
        providers: voiceProviders,
        ttsProvider: this.config.voice?.ttsProvider || '',
        ttsVoice: this.config.voice?.ttsVoice || '',
        ttsModel: this.config.voice?.ttsModel || '',
        edgeVoice: this.config.voice?.edgeVoice || 'en-US-AriaNeural',
        ready: !!pipeline,
        sttConfigured,
        note: sttConfigured
          ? (pipeline ? 'Voice pipeline is ready.' : 'Voice is enabled but the pipeline is not ready.')
          : 'Voice needs an STT plugin installed and configured - open Settings -> Plugins.',
      },
      runtime: {
        publicUrl: this.config.publicUrl || null,
        webPort: this.config.webPort || null,
        workspacePath: this.config.workspacePath || process.cwd(),
        dataDir: this.config.dataDir || null,
      },
      models: {
        casual: this.normalizeSettingsModelRef(this.config.casualModel),
        normal: this.normalizeSettingsModelRef(this.config.normalModel),
        planner: this.normalizeSettingsModelRef(this.config.plannerModel),
        subagent: this.normalizeSettingsModelRef(this.config.subagentModel),
        learner: this.normalizeSettingsModelRef(this.config.learnerModel),
        imageVlm: this.normalizeSettingsModelRef(this.config.imageVlmModel),
        videoVlm: this.normalizeSettingsModelRef(this.config.videoVlmModel),
        audioVlm: this.normalizeSettingsModelRef(this.config.audioVlmModel),
        recall: this.normalizeSettingsModelRef(this.config.recallModel),
      },
      providers: {
        registered: this._registeredProvidersBlock(),
        anthropic: {
          apiKey: '',
          apiKeySet: !!this.config.anthropicApiKey,
        },
        openai: {
          apiKey: '',
          apiKeySet: !!this.config.openaiApiKey,
          baseUrl: this.config.openaiBaseUrl || '',
        },
        openrouter: {
          apiKey: '',
          apiKeySet: !!this.config.openrouterApiKey,
          baseUrl: this.config.openrouterBaseUrl || '',
          referer: this.config.openrouterReferer || '',
        },
        local: {
          apiKey: '',
          apiKeySet: !!this.config.localModelApiKey,
          baseUrl: this.config.localModelBaseUrl || '',
        },
        zai: (() => {
          const slot = this.config?.plugins?.['z-ai-provider'] || {};
          const apiKey = process.env.ZAI_API_KEY || this.config.zaiApiKey || slot.apiKey || '';
          const baseUrl = process.env.ZAI_BASE_URL || this.config.zaiBaseUrl || slot.baseUrl || '';
          return { apiKey: '', apiKeySet: !!apiKey, baseUrl };
        })(),
        custom: customProviders,
      },
      webSearch: {
        searxngUrl: this.config.searxngUrl || '',
        searxngApiKey: this.config.searxngApiKey ? '***hidden***' : '',
        searxngApiKeySet: !!this.config.searxngApiKey,
        braveApiKey: this.config.braveApiKey ? '***hidden***' : '',
        braveApiKeySet: !!this.config.braveApiKey,
      },
      embeddings: {
        active: this.config.embedder || '',
      },
      inviteKey: '',
      inviteKeySet: !!this.config.inviteKey,
      modelLimits: this.config.modelLimits || {},
      tokenPricing: this.config.tokenPricing || {},
      agent: this._agentSettingsBlock(),
      budgets: this._budgetSettingsBlock(),
      browser: {
        backend: this.config.browserBackend || 'zendriver',
        availableBackends: ['zendriver', 'playwright'],
      },
      sources: {
        displayName: envDisplay ? 'env' : (fileConfig.displayName ? 'file' : 'derived'),
        nicknames: envNicknames ? 'env' : ((Array.isArray(fileConfig.nicknames) && fileConfig.nicknames.length) ? 'file' : 'derived'),
        proactive: envProactive ? 'env' : (fileConfig.proactive ? 'file' : 'default'),
        voice: envVoice ? 'env' : (fileConfig.voice ? 'file' : 'default'),
        enhancedRecall: Object.prototype.hasOwnProperty.call(fileConfig, 'enhancedRecall') ? 'file' : 'default',
        models: 'env',
        providers: 'env',
        browser: process.env.SPORE_BROWSER_BACKEND ? 'env' : (fileConfig.browserBackend ? 'file' : 'default'),
      },
      plugins: this.buildPluginsSettingsBlock(),
    };
  }

  getCanonicalSettingsState(opts = {}) {
    const settings = require('../../settings');
    const ui = settings.snapshotForUI(opts);
    const schema = settings.allDefs()
      .filter(def => !opts.scope || def.scope.includes(opts.scope))
      .map(def => ({
        key: def.key,
        type: def.type,
        label: def.label || null,
        group: def.group || null,
        scope: def.scope || [],
        envVar: def.envVar || null,
        secret: !!def.secret,
        default: def.secret ? null : def.default,
        enum: def.enum || null,
        pluginId: def.pluginId || null,
      }));
    return { values: ui.values, meta: ui.meta, schema };
  }

  getSettingsResponse(opts = {}) {
    const role = String(opts.role || 'creator').toLowerCase();
    const isCreator = role === 'creator' || role === 'admin';
    if (!isCreator) {
      return {
        readonly: true,
        personalOnly: true,
        values: {},
        meta: {},
        schema: [],
        identity: {
          agentId: this.config.agentId,
          displayName: this.config.displayName || this.deriveDisplayName(this.config.agentId),
          nicknames: [],
        },
        memory: {},
        plugins: { enabled: false, hotReload: false, panes: [], dockItems: [], available: [] },
      };
    }
    return { ...this.getSettingsState(), ...this.getCanonicalSettingsState(opts) };
  }

  applyCanonicalPatch(patch, opts = {}) {
    const settings = require('../../settings');
    const nextPatch = { ...(patch || {}) };
    const generatedSecrets = {};
    if (opts.actions?.regenerateInviteKey) {
      const inviteKey = this._generateInviteKey();
      nextPatch.inviteKey = inviteKey;
      generatedSecrets.inviteKey = inviteKey;
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'providers.custom')) {
      nextPatch['providers.custom'] = this._normalizeCustomProvidersForPatch(nextPatch['providers.custom']);
    }
    const pluginBefore = this._snapshotPluginConfigsForPatch(nextPatch);
    const result = settings.applyPatch(nextPatch, { actor: opts.actor || 'web' });
    this.mirrorSettingsToLegacyConfig();
    this._dispatchPluginConfigChanges(pluginBefore);
    return {
      result,
      settings: this.getSettingsResponse({ ...opts, role: opts.role || 'creator' }),
      generatedSecrets,
    };
  }

  _generateInviteKey() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
  }

  _normalizeCustomProvidersForPatch(rawProviders) {
    if (!Array.isArray(rawProviders)) return rawProviders;
    const existing = this.config.customProviders || {};
    const prepared = rawProviders.map(entry => {
      const name = String(entry?.name || '').trim().toLowerCase();
      const key = entry?.key === '__KEEP__'
        ? (existing[name]?.key || (name === 'local' ? this.config.localModelApiKey : '') || '')
        : entry?.key;
      return { ...(entry || {}), name, key };
    });
    return this.normalizeSettingsCustomProviders(prepared);
  }

  _customProvidersArrayToConfig(rawProviders) {
    const out = {};
    for (const provider of this.normalizeSettingsCustomProviders(rawProviders)) {
      out[provider.name] = {
        url: provider.url,
        key: provider.key,
        authHeader: provider.authHeader,
      };
    }
    return out;
  }

  _snapshotPluginConfigsForPatch(patch) {
    const out = new Map();
    if (!patch || typeof patch !== 'object') return out;
    for (const key of Object.keys(patch)) {
      const match = key.match(/^plugins\.([^.]+)\./);
      if (!match) continue;
      const pluginId = match[1];
      if (!out.has(pluginId)) {
        out.set(pluginId, { ...(this.config.plugins?.[pluginId] || {}) });
      }
    }
    return out;
  }

  _dispatchPluginConfigChanges(beforeByPlugin) {
    if (!beforeByPlugin?.size) return;
    const mgr = this.tools?._pluginManager;
    if (!mgr?.dispatchConfigChange) return;

    for (const [pluginId, before] of beforeByPlugin) {
      const after = { ...(this.config.plugins?.[pluginId] || {}) };
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      mgr.dispatchConfigChange(pluginId, before, after).catch(e => {
        this.log.warn(`[settings] plugin ${pluginId} config-change failed: ${e?.message}`);
      });
    }
  }

  _registeredProvidersBlock() {
    const mgr = this.tools?._pluginManager;
    if (!mgr?.getProviders) return [];
    const panes = mgr.getSettingsPanes ? mgr.getSettingsPanes() : [];
    const paneByPluginId = new Map(panes.map(p => [p.pluginId, p]));
    return mgr.getProviders().map(p => {
      const pane = paneByPluginId.get(p.pluginId) || null;
      return {
        name: p.name,
        pluginId: p.pluginId,
        label: p.label || p.name,
        configured: !!p.configured,
        defaultBaseUrl: p.defaultBaseUrl || null,
        capabilities: p.capabilities || {},
        formFields: pane?.schema || [],
        values: pane?.values || {},
        meta: pane?.meta || {},
        description: pane?.description || '',
      };
    });
  }

  _agentSettingsBlock() {
    const tier = resolveEffortTier(this.config);
    const eff = EFFORT_PRESETS[tier] || EFFORT_PRESETS[DEFAULT_EFFORT];
    return {
      effort: {
        value: tier,
        tiers: EFFORT_TIERS,
        presets: EFFORT_PRESETS,
      },
      budgets: {
        casualMessageBudget: Number.isFinite(this.config.casualMessageBudget) ? this.config.casualMessageBudget : null,
        complexMessageBudget: Number.isFinite(this.config.complexMessageBudget) ? this.config.complexMessageBudget : null,
        compactTokenThreshold: Number.isFinite(this.config.compactTokenThreshold) ? this.config.compactTokenThreshold : null,
        maxToolResultChars: Number.isFinite(this.config.maxToolResultChars) ? this.config.maxToolResultChars : null,
        defaults: {
          casualMessageBudget: eff.casualMessageBudget,
          complexMessageBudget: eff.complexMessageBudget,
          compactTokenThreshold: 120000,
          maxToolResultChars: eff.maxToolResultChars,
        },
      },
    };
  }

  _budgetSettingsBlock() {
    const G = this.graph?.constructor;
    const sectionDefaults = G ? { ...G.SECTION_BUDGETS } : {};
    const totalDefault = G ? G.TOTAL_BUDGET : 40000;
    const sections = this.graph?._sectionBudgets ? { ...this.graph._sectionBudgets } : { ...sectionDefaults };
    const total = this.graph?._totalBudget ?? totalDefault;
    return {
      runtime: sections.runtime ?? sectionDefaults.runtime ?? null,
      total,
      sections,
      sectionDefaults,
      totalDefault,
    };
  }

  buildPluginsSettingsBlock() {
    const mgr = this.tools?._pluginManager;
    if (!mgr?.getSettingsPanes) {
      return {
        enabled: !!this.config.pluginsEnabled,
        hotReload: !!this.config.pluginsHotReload,
        panes: [],
        dockItems: [],
        available: [],
        gateways: [],
        dirs: { bundled: null, user: null },
      };
    }
    const dirs = mgr.getDiscoveryDirs?.() || {};
    return {
      enabled: !!this.config.pluginsEnabled,
      hotReload: !!this.config.pluginsHotReload,
      dirs: { bundled: dirs.bundled || null, user: dirs.user || null },
      panes: mgr.getSettingsPanes(),
      dockItems: mgr.getDockItems?.() || [],
      available: mgr.listAvailable?.() || [],
      gateways: this.tools?.platformManager?.listChannels?.() || [],
    };
  }

  ensurePluginConfigPersister() {
    const mgr = this.tools?._pluginManager;
    if (!mgr?.setConfigPersister) return;
    if (mgr._configPersister) return;
    mgr.setConfigPersister(async (pluginId, partial) => {
      this.persistSettingsPatch({ plugins: { [pluginId]: partial } });
      return { ...(this.config.plugins?.[pluginId] || {}) };
    });
  }

  persistSettingsPatch(body = {}, opts = {}) {
    this.ensurePluginConfigPersister();
    const settings = require('../../settings');
    const generatedSecrets = {};
    let effectiveBody = body || {};
    if (effectiveBody?.inviteKeyRegenerate) {
      const inviteKey = this._generateInviteKey();
      generatedSecrets.inviteKey = inviteKey;
      effectiveBody = { ...effectiveBody, inviteKey };
    } else if (effectiveBody?.ensureInviteKey && !this.config.inviteKey && !effectiveBody.inviteKey) {
      const inviteKey = this._generateInviteKey();
      generatedSecrets.inviteKey = inviteKey;
      effectiveBody = { ...effectiveBody, inviteKey };
    }

    let flat;
    try {
      flat = settings.flattenWizardPayload(effectiveBody);
      if (Object.prototype.hasOwnProperty.call(flat, 'providers.custom')) {
        flat['providers.custom'] = this._normalizeCustomProvidersForPatch(flat['providers.custom']);
      }
    } catch (e) {
      this.log.warn(`[settings] flatten failed: ${e?.message}`);
      throw e;
    }

    const pluginPayload = (effectiveBody.plugins && typeof effectiveBody.plugins === 'object') ? effectiveBody.plugins : null;
    if (pluginPayload) this._persistPluginPayload(pluginPayload, settings);

    const corePatch = {};
    for (const [k, v] of Object.entries(flat)) {
      if (k.startsWith('plugins.')) continue;
      corePatch[k] = v;
    }
    if (Object.keys(corePatch).length) {
      settings.applyPatch(corePatch, { actor: 'web' });
    }

    this.mirrorSettingsToLegacyConfig();
    this.ensureModelLibraryFromRouting();
    const state = this.getSettingsState();
    if (opts.returnGeneratedSecrets) return { settings: state, generatedSecrets };
    return state;
  }

  ensureModelLibraryFromRouting() {
    try {
      const settings = require('../../settings');
      const lib = require('../../settings/model-library');
      lib.ensureFromSettingsSnapshot(settings.snapshot(), { source: 'auto' });
    } catch (e) {
      this.log.warn(`[settings] model-library route seed failed: ${e?.message}`);
    }
  }

  _persistPluginPayload(pluginPayload, settings) {
    const mgr = this.tools?._pluginManager;
    if (!this.config.plugins) this.config.plugins = {};

    for (const [pluginId, partial] of Object.entries(pluginPayload)) {
      if (!partial || typeof partial !== 'object') continue;
      const before = { ...(this.config.plugins[pluginId] || {}) };
      const pluginPatch = {};

      for (const [field, value] of Object.entries(partial)) {
        const key = `plugins.${pluginId}.${field}`;
        if (!settings.getDef(key)) {
          this.log.debug(`[settings] plugin ${pluginId} field "${field}" not in registry - legacy mirror only`);
          continue;
        }
        if (value === '' || value === undefined) continue;
        pluginPatch[key] = value;
      }

      if (Object.keys(pluginPatch).length) {
        settings.applyPatch(pluginPatch, { actor: `plugin:${pluginId}` });
      }

      const after = { ...before };
      for (const [field, value] of Object.entries(partial)) {
        if (value === null) delete after[field];
        else after[field] = value;
      }
      this.config.plugins[pluginId] = after;

      if (mgr?.dispatchConfigChange) {
        mgr.dispatchConfigChange(pluginId, before, after).catch(e => {
          this.log.warn(`[settings] plugin ${pluginId} config-change failed: ${e?.message}`);
        });
      }
    }
  }

  mirrorSettingsToLegacyConfig() {
    const settings = require('../../settings');
    const snap = settings.snapshot();

    if (snap.displayName !== undefined) this.config.displayName = snap.displayName;
    if (Array.isArray(snap.nicknames)) this.config.nicknames = snap.nicknames;
    if (snap.agentId) this.config.agentId = snap.agentId;
    if (snap.enhancedRecall !== undefined) this.config.enhancedRecall = !!snap.enhancedRecall;

    const models = snap.models || {};
    if (models.casual !== undefined) this.config.casualModel = models.casual;
    if (models.normal !== undefined) this.config.normalModel = models.normal;
    if (models.planner !== undefined) this.config.plannerModel = models.planner;
    if (models.subagent !== undefined) this.config.subagentModel = models.subagent;
    if (models.learner !== undefined) this.config.learnerModel = models.learner;
    if (models.imageVlm !== undefined) this.config.imageVlmModel = models.imageVlm;
    if (models.videoVlm !== undefined) this.config.videoVlmModel = models.videoVlm;
    if (models.audioVlm !== undefined) this.config.audioVlmModel = models.audioVlm;
    if (models.recall !== undefined) this.config.recallModel = models.recall;
    if (models.visionFallback !== undefined) this.config.visionFallbackModel = models.visionFallback;
    if (models.audioFallback !== undefined) this.config.audioFallbackModel = models.audioFallback;
    if (models.videoFallback !== undefined) this.config.videoFallbackModel = models.videoFallback;
    this.config.model = this.config.plannerModel || this.config.normalModel || this.config.casualModel || null;
    if (snap.modelLimits !== undefined) this.config.modelLimits = snap.modelLimits;
    if (snap.tokenPricing !== undefined) this.config.tokenPricing = snap.tokenPricing;

    const providers = snap.providers || {};
    if (providers.anthropic?.apiKey !== undefined) this.config.anthropicApiKey = providers.anthropic.apiKey;
    if (providers.openai?.apiKey !== undefined) this.config.openaiApiKey = providers.openai.apiKey;
    if (providers.openai?.baseUrl !== undefined) this.config.openaiBaseUrl = providers.openai.baseUrl;
    if (providers.openrouter?.apiKey !== undefined) this.config.openrouterApiKey = providers.openrouter.apiKey;
    if (providers.openrouter?.baseUrl !== undefined) this.config.openrouterBaseUrl = providers.openrouter.baseUrl;
    if (providers.openrouter?.referer !== undefined) this.config.openrouterReferer = providers.openrouter.referer;
    if (providers.local?.apiKey !== undefined) this.config.localModelApiKey = providers.local.apiKey;
    if (providers.local?.baseUrl !== undefined) this.config.localModelBaseUrl = providers.local.baseUrl;
    if (providers.local?.authHeader !== undefined) this.config.localModelAuthHeader = providers.local.authHeader;
    if (providers.gemini?.apiKey !== undefined) this.config.geminiApiKey = providers.gemini.apiKey;
    if (providers.custom !== undefined && settings.provenance('providers.custom') !== 'default') {
      this.config.customProviders = this._customProvidersArrayToConfig(providers.custom);
      const local = this.config.customProviders?.local;
      if (local?.url) {
        this.config.localModelBaseUrl = local.url;
        this.config.localModelApiKey = local.key || '';
        this.config.localModelAuthHeader = local.authHeader || 'bearer';
      }
    }

    const ws = snap.webSearch || {};
    if (ws.searxngUrl !== undefined) this.config.searxngUrl = ws.searxngUrl;
    if (ws.searxngApiKey !== undefined) this.config.searxngApiKey = ws.searxngApiKey;
    if (ws.braveApiKey !== undefined) this.config.braveApiKey = ws.braveApiKey;

    if (snap.voice) this.config.voice = { ...(this.config.voice || {}), ...snap.voice };
    if (snap.proactive) this.config.proactive = { ...(this.config.proactive || {}), ...snap.proactive };
    if (snap.plannerAdvisor) this.config.plannerAdvisor = { ...(this.config.plannerAdvisor || {}), ...snap.plannerAdvisor };
    if (snap.plugins && typeof snap.plugins === 'object') {
      this.config.plugins = { ...(this.config.plugins || {}), ...snap.plugins };
    }

    if (snap.channels) {
      this.config.channels = { ...(this.config.channels || {}), ...snap.channels };
      const tg = snap.channels.telegram;
      if (tg?.botToken !== undefined) this.config.telegramBotToken = tg.botToken;
      const sl = snap.channels.slack;
      if (sl?.botToken !== undefined) this.config.slackBotToken = sl.botToken;
      if (sl?.appToken !== undefined) this.config.slackAppToken = sl.appToken;
      const dc = snap.channels.discord;
      if (dc?.token !== undefined) this.config.discordToken = dc.token;
      if (dc?.admins !== undefined) this.config.discordAdmins = dc.admins;
      if (dc?.maxMessageLength !== undefined) this.config.maxMessageLength = dc.maxMessageLength;
      if (dc?.typingInterval !== undefined) this.config.typingInterval = dc.typingInterval;
      if (dc?.maxQueuePerChannel !== undefined) this.config.maxQueuePerChannel = dc.maxQueuePerChannel;
      if (dc?.messageDebounceMs !== undefined) this.config.messageDebounceMs = dc.messageDebounceMs;
    }

    if (snap.browserBackend !== undefined) this.config.browserBackend = snap.browserBackend;

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
      'logLevel',
      'agentBornDate',
    ]) {
      if (snap[k] !== undefined) this.config[k] = snap[k];
    }

    // Null means "use the runtime-derived workspace" (usually /workspace in
    // Docker), not "fall back to process.cwd()". Keep this in sync with
    // config.js _mirrorSettingsIntoLegacyConfig.
    if (snap.workspacePath) {
      this.config.workspacePath = path.isAbsolute(snap.workspacePath)
        ? snap.workspacePath
        : path.resolve(__dirname, '..', '..', snap.workspacePath);
    }
  }

  applyOnboardingToGraph(db, payload = {}) {
    let agentId = this.config.agentId;
    let selfRow = agentId && db.prepare('SELECT id FROM nodes WHERE id = ?').get(agentId);
    if (!selfRow) selfRow = db.prepare("SELECT id FROM nodes WHERE type = 'self' LIMIT 1").get();
    if (!selfRow) {
      this.log.warn('[onboarding] no self node found; skipping graph sync');
      return;
    }
    agentId = selfRow.id;

    const run = () => {
      const displayName = String(payload.displayName || '').trim();
      const nicknames = Array.isArray(payload.nicknames)
        ? payload.nicknames.map(s => String(s).trim()).filter(Boolean)
        : [];

      if (displayName) {
        const pitch = nicknames.length
          ? `${displayName} - known as ${nicknames.join(', ')}. Configured via the first-run wizard.`
          : `${displayName}. Configured via the first-run wizard.`;
        db.prepare("UPDATE nodes SET label = ?, description = ?, updated = datetime('now') WHERE id = ?")
          .run(displayName, pitch, agentId);
      }

      if (nicknames.length) {
        db.prepare('DELETE FROM aliases WHERE node_id = ?').run(agentId);
        const ins = db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)');
        for (const a of nicknames) ins.run(agentId, a);
      }

      const ensureAspect = (nodeId, name, weight) => {
        const existing = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, name);
        if (existing) return existing.id;
        return db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?,?,?,?)')
          .run(nodeId, name, weight, 'onboarding').lastInsertRowid;
      };
      const upsertAttr = (aspectId, content, importance) => {
        const existing = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(aspectId, content);
        if (existing) return;
        db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?,?,?,?,?)')
          .run(aspectId, content, importance, 'onboarding', 'onboarding');
      };

      const providers = payload.providers || {};
      const configuredProviders = [];
      if (providers.anthropic?.apiKey) configuredProviders.push('Anthropic (ANTHROPIC_API_KEY)');
      if (providers.openai?.apiKey) configuredProviders.push('OpenAI (OPENAI_API_KEY)');
      if (providers.openrouter?.apiKey) configuredProviders.push('OpenRouter (OPENROUTER_API_KEY)');
      if (providers.local?.apiKey || providers.local?.baseUrl) configuredProviders.push('Local OAI-compatible (LOCAL_MODEL_*)');
      if (Array.isArray(providers.custom)) {
        for (const p of providers.custom) {
          if (p?.name && (p.key || p.url)) configuredProviders.push(`Custom provider: ${p.name}`);
        }
      }
      if (configuredProviders.length) {
        const refApiKeys = db.prepare("SELECT id FROM nodes WHERE id = 'ref-api-keys'").get();
        const targetNode = refApiKeys ? 'ref-api-keys' : agentId;
        const aspId = ensureAspect(targetNode, 'configured_providers', 8);
        for (const line of configuredProviders) upsertAttr(aspId, `${line} - configured during onboarding`, 7);
      }

      const models = payload.models || {};
      const modelLines = [];
      for (const [tier, ref] of Object.entries(models)) {
        if (!ref) continue;
        const provider = ref.provider || '';
        const name = (ref.model || '').trim();
        if (!name) continue;
        const full = provider && provider !== 'anthropic' ? `${provider}/${name}` : name;
        modelLines.push(`${tier}: ${full}`);
      }
      if (modelLines.length) {
        const aspId = ensureAspect(agentId, 'model_routing', 7);
        for (const line of modelLines) upsertAttr(aspId, line, 6);
      }

      const voice = payload.voice || {};
      if (voice.enabled) {
        const aspId = ensureAspect(agentId, 'voice_pipeline', 6);
        const parts = [];
        if (voice.sttProvider) parts.push(`STT: ${voice.sttProvider}`);
        if (voice.ttsProvider) parts.push(`TTS: ${voice.ttsProvider}`);
        if (voice.ttsVoice) parts.push(`voice: ${voice.ttsVoice}`);
        upsertAttr(aspId, `Voice enabled - ${parts.join(', ') || 'defaults'}`, 6);
      }

      const ws = payload.webSearch || {};
      if (ws.searxngUrl || ws.braveApiKey) {
        const refApiKeys = db.prepare("SELECT id FROM nodes WHERE id = 'ref-api-keys'").get();
        const targetNode = refApiKeys ? 'ref-api-keys' : agentId;
        const aspId = ensureAspect(targetNode, 'web_search', 7);
        if (ws.searxngUrl) upsertAttr(aspId, `SearXNG configured (primary): ${ws.searxngUrl}`, 7);
        if (ws.braveApiKey && ws.braveApiKey !== '***hidden***') upsertAttr(aspId, 'Brave Search configured (fallback)', 6);
      }

      const browserBackend = payload.browser?.backend;
      if (browserBackend) {
        const aspId = ensureAspect(agentId, 'tooling_preferences', 5);
        upsertAttr(aspId, `Browser backend: ${browserBackend}`, 5);
      }

      if (payload.theme) {
        const aspId = ensureAspect(agentId, 'operator_preferences', 4);
        upsertAttr(aspId, `UI theme: ${payload.theme}`, 4);
      }
    };

    try {
      db.exec('BEGIN');
      run();
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
}

module.exports = { WebSettingsService };
