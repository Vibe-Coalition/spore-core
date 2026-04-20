'use strict';

const PlaywrightBrowserBackend = require('./playwright-browser-backend');
const ZendriverBrowserBackend = require('./zendriver-browser-backend');

class BrowserTool {
  constructor(log, broadcastFn, config = null) {
    this.log = log;
    this._broadcast = broadcastFn;
    this.config = config;
    this._backends = new Map();
    this._activeBackend = null;
  }

  _defaultBackend() {
    return this._normalizeBackend(this.config?.browserBackend || 'zendriver');
  }

  _normalizeBackend(name) {
    const raw = String(name || '').trim().toLowerCase();
    if (!raw) return this.config?.browserBackend ? this._defaultBackend() : 'zendriver';
    if (raw === 'pw') return 'playwright';
    if (raw === 'zd') return 'zendriver';
    return raw;
  }

  _getBackend(name) {
    const normalized = this._normalizeBackend(name);
    if (!this._backends.has(normalized)) {
      let BackendClass;
      switch (normalized) {
        case 'playwright':
          BackendClass = PlaywrightBrowserBackend;
          break;
        case 'zendriver':
          BackendClass = ZendriverBrowserBackend;
          break;
        default:
          throw new Error(`Unknown browser backend: ${normalized}. Use playwright or zendriver.`);
      }
      this._backends.set(normalized, new BackendClass(this.log, this._broadcast));
    }
    return this._backends.get(normalized);
  }

  async _findRunningBackend(exceptName = null) {
    for (const [name, backend] of this._backends.entries()) {
      if (name === exceptName) continue;
      if (typeof backend.isRunning === 'function' && backend.isRunning()) return name;
    }
    return null;
  }

  _decorateResult(backend, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    return { backend, ...result };
  }

  async execute(input) {
    const action = (input.action || '').toLowerCase();
    const selectedBackend = this._normalizeBackend(input.backend || this._activeBackend || this._defaultBackend());

    if (action === 'launch') {
      const runningElsewhere = await this._findRunningBackend(selectedBackend);
      if (runningElsewhere) {
        return {
          error: `Browser backend "${runningElsewhere}" is already running. Close it before launching "${selectedBackend}".`,
          backend: runningElsewhere,
        };
      }
    }

    let backend;
    try {
      backend = this._getBackend(selectedBackend);
    } catch (e) {
      return { error: e.message };
    }

    const result = await backend.execute(input);
    if (result && !result.error) {
      if (result.status === 'launched' || result.status === 'already_running' || result.status === 'running') {
        this._activeBackend = selectedBackend;
      } else if (action === 'close' && this._activeBackend === selectedBackend) {
        this._activeBackend = null;
      }
    }

    const decorated = this._decorateResult(selectedBackend, result);
    if (action === 'status' && decorated && typeof decorated === 'object' && !Array.isArray(decorated)) {
      decorated.activeBackend = this._activeBackend;
      decorated.availableBackends = ['playwright', 'zendriver'];
      decorated.defaultBackend = this._defaultBackend();
    }
    return decorated;
  }

  async destroy() {
    for (const backend of this._backends.values()) {
      try {
        await backend.destroy();
      } catch (e) {
        this.log.warn(`[browser] Backend destroy failed: ${e.message}`);
      }
    }
    this._backends.clear();
    this._activeBackend = null;
  }
}

module.exports = BrowserTool;
