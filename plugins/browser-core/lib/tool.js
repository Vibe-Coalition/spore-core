'use strict';

// BrowserTool — the dispatcher behind the agent's `browser` tool. It
// owns no Chrome/CDP code itself; everything that actually drives a
// browser lives in backend plugins (zendriver, playwright). This class
// just:
//   • picks a backend (via input.backend OR active session OR config
//     default OR registered fallback)
//   • lazy-instantiates the backend (one instance per backend per
//     BrowserTool)
//   • prevents two backends running simultaneously (launch on one
//     errors out if another is already running)
//   • decorates results with the backend name + status metadata
//
// Backend lookup is via the plugin manager. Backends register
// themselves with api.registerBrowserBackend(name, factory, opts).

class BrowserTool {
  constructor({ log, broadcast, config, pluginManager }) {
    this.log = log;
    this._broadcast = broadcast;
    this.config = config || null;
    this._pluginManager = pluginManager;
    this._backends = new Map();         // normalizedName → backend instance
    this._activeBackend = null;         // last backend that was successfully launched
  }

  // ── Backend resolution ────────────────────────────────────────────
  // Each call walks the live plugin-manager list, so installing/
  // uninstalling a backend plugin takes effect on the next browser
  // call without a process restart.
  _allRegisteredBackends() {
    const all = this._pluginManager?.getBrowserBackends?.() || [];
    return all.filter(b => b.available);
  }

  // Drop cached backend instances whose plugin has been uninstalled.
  // Without this, _backends keeps the live instance + its child python
  // helper around forever (resource pin), and on plugin reinstall we'd
  // hand back the STALE instance — code edits to the wrapper wouldn't
  // take effect until process restart. Called at the top of execute()
  // before backend resolution so each call sees a fresh registry.
  _pruneStaleBackends() {
    if (this._backends.size === 0) return;
    const live = new Set(this._allRegisteredBackends().map(b => b.name));
    for (const [name, instance] of [...this._backends.entries()]) {
      if (live.has(name)) continue;
      try {
        // destroy is async but we don't await — the caller doesn't
        // care, and blocking on shutdown would slow every browser
        // call. Worst case: a python helper takes a few hundred ms
        // to exit in the background.
        instance.destroy?.();
      } catch (e) {
        this.log.warn(`[browser-core] stale backend "${name}" destroy threw: ${e.message}`);
      }
      this._backends.delete(name);
      if (this._activeBackend === name) this._activeBackend = null;
      this.log.info(`[browser-core] dropped stale backend cache for "${name}" (plugin uninstalled)`);
    }
  }

  _resolveSelector(name) {
    const raw = String(name || '').trim().toLowerCase();
    if (!raw) return null;
    for (const b of this._allRegisteredBackends()) {
      if (b.name === raw) return b;
      if ((b.aliases || []).some(a => String(a).toLowerCase() === raw)) return b;
    }
    return null;
  }

  _defaultBackendName() {
    // 1. config.browserBackend if set and that backend is available
    const cfg = String(this.config?.browserBackend || '').trim().toLowerCase();
    if (cfg) {
      const hit = this._resolveSelector(cfg);
      if (hit) return hit.name;
    }
    // 2. preference order: zendriver before playwright
    const pref = ['zendriver', 'playwright'];
    const all = this._allRegisteredBackends();
    for (const want of pref) {
      const hit = all.find(b => b.name === want);
      if (hit) return hit.name;
    }
    // 3. first available
    return all[0]?.name || null;
  }

  _getBackendInstance(entry) {
    const name = entry.name;
    if (!this._backends.has(name)) {
      const backend = entry.factory({
        log: this.log,
        broadcast: this._broadcast,
        config: this.config,
      });
      if (!backend || typeof backend.execute !== 'function') {
        throw new Error(`Browser backend "${name}" factory returned an invalid instance`);
      }
      this._backends.set(name, backend);
    }
    return this._backends.get(name);
  }

  async _findRunningBackend(exceptName = null) {
    for (const [name, backend] of this._backends.entries()) {
      if (name === exceptName) continue;
      if (typeof backend.isRunning === 'function' && backend.isRunning()) return name;
    }
    return null;
  }

  _decorateResult(name, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    return { backend: name, ...result };
  }

  _normalizeSporeServedInput(input, toolCtx = {}) {
    if (!input?.url || !['launch', 'navigate', 'tab_open'].includes(String(input.action || '').toLowerCase())) {
      return input;
    }
    const webPort = String(this.config?.webPort || process.env.SPORE_WEB_PORT || '').trim();
    if (!webPort) return input;

    let parsed;
    try {
      const raw = String(input.url || '');
      parsed = raw.startsWith('/serve/')
        ? new URL(`http://127.0.0.1:${webPort}${raw}`)
        : new URL(raw);
    } catch {
      return input;
    }

    const host = String(parsed.hostname || '').toLowerCase();
    const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    const isSporeServe = localHost && String(parsed.port || '') === webPort && parsed.pathname.startsWith('/serve/');
    if (!isSporeServe) return input;

    const cookieName = toolCtx.sessionCookieName || null;
    const cookieValue = toolCtx.sessionToken || null;
    const cookies = cookieName && cookieValue
      ? [{ name: cookieName, value: cookieValue, url: `http://127.0.0.1:${webPort}/`, path: '/' }]
      : [];
    const hasPlaywright = this._allRegisteredBackends().some(b => b.name === 'playwright');
    return {
      ...input,
      url: `http://127.0.0.1:${webPort}${parsed.pathname}${parsed.search}${parsed.hash}`,
      allowLocalSpore: true,
      sporeServedApp: true,
      ...(cookies.length ? { cookies } : {}),
      ...(!input.backend && hasPlaywright ? { backend: 'playwright' } : {}),
    };
  }

  async execute(input, toolCtx = {}) {
    this._pruneStaleBackends();
    const actionAliases = {
      open: 'navigate',
      visit: 'navigate',
      goto: 'navigate',
      go_to: 'navigate',
      load: 'navigate',
    };
    let action = (input.action || '').toLowerCase();
    if (actionAliases[action]) {
      action = actionAliases[action];
      input = { ...input, action };
    }
    input = this._normalizeSporeServedInput(input, toolCtx);
    const requested = input.backend || this._activeBackend || this._defaultBackendName();
    const entry = this._resolveSelector(requested);
    if (!entry) {
      const available = this._allRegisteredBackends().map(b => b.name);
      const hint = available.length
        ? `Available: ${available.join(', ')}.`
        : 'No browser backends are installed. Install the zendriver or playwright plugin.';
      return { error: `Unknown browser backend "${requested}". ${hint}` };
    }

    if (action === 'launch') {
      const runningElsewhere = await this._findRunningBackend(entry.name);
      if (runningElsewhere) {
        return {
          error: `Browser backend "${runningElsewhere}" is already running. Close it before launching "${entry.name}".`,
          backend: runningElsewhere,
        };
      }
    }

    let backend;
    try {
      backend = this._getBackendInstance(entry);
    } catch (e) {
      return { error: e.message };
    }

    const autoLaunchActions = new Set([
      'navigate', 'tab_open', 'tab_list', 'tab_switch',
      'click', 'type', 'screenshot', 'scroll', 'evaluate', 'snapshot',
    ]);
    if (autoLaunchActions.has(action) && typeof backend.isRunning === 'function' && !backend.isRunning()) {
      const launchInput = {
        action: 'launch',
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
      };
      const launched = await backend.execute(launchInput);
      if (launched?.error) return this._decorateResult(entry.name, launched);
      this._activeBackend = entry.name;
    }

    let result;
    try {
      result = await backend.execute(input);
    } catch (e) {
      return { error: `Browser backend "${entry.name}" failed: ${e.message}` };
    }
    if (result && !result.error) {
      if (result.status === 'launched' || result.status === 'already_running' || result.status === 'running') {
        this._activeBackend = entry.name;
      } else if (action === 'close' && this._activeBackend === entry.name) {
        this._activeBackend = null;
      }
    }

    const decorated = this._decorateResult(entry.name, result);
    if (action === 'status' && decorated && typeof decorated === 'object' && !Array.isArray(decorated)) {
      decorated.activeBackend = this._activeBackend;
      decorated.availableBackends = this._allRegisteredBackends().map(b => b.name);
      decorated.defaultBackend = this._defaultBackendName();
    }
    return decorated;
  }

  async destroy() {
    for (const backend of this._backends.values()) {
      try {
        await backend.destroy();
      } catch (e) {
        this.log.warn(`[browser-core] Backend destroy failed: ${e.message}`);
      }
    }
    this._backends.clear();
    this._activeBackend = null;
  }
}

module.exports = BrowserTool;
