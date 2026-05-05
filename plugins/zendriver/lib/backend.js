'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const { getBlockedUrlError, encodeBrowserFrame } = require('../../browser-core/lib/url-block');

function _positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

class ZendriverBrowserBackend {
  constructor({ log, broadcast, config } = {}) {
    this.name = 'zendriver';
    this.log = log;
    this._broadcast = broadcast;
    this._config = config || null;
    this._proc = null;
    this._stdout = null;
    this._stderr = '';
    this._pending = new Map();
    this._nextId = 1;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._running = false;
    this._defaultTimeoutMs = _positiveInt(
      process.env.SPORE_ZENDRIVER_ACTION_TIMEOUT_MS || config?.zendriverActionTimeoutMs,
      30000,
    );
    this._timeoutsMs = {
      launch: _positiveInt(process.env.SPORE_ZENDRIVER_LAUNCH_TIMEOUT_MS || config?.zendriverLaunchTimeoutMs, 40000),
      navigate: _positiveInt(process.env.SPORE_ZENDRIVER_NAVIGATION_TIMEOUT_MS || config?.zendriverNavigationTimeoutMs, 35000),
      tab_open: _positiveInt(process.env.SPORE_ZENDRIVER_NAVIGATION_TIMEOUT_MS || config?.zendriverNavigationTimeoutMs, 35000),
      snapshot: _positiveInt(process.env.SPORE_ZENDRIVER_SNAPSHOT_TIMEOUT_MS || config?.zendriverSnapshotTimeoutMs, 25000),
      screenshot: _positiveInt(process.env.SPORE_ZENDRIVER_SCREENSHOT_TIMEOUT_MS || config?.zendriverScreenshotTimeoutMs, 15000),
      evaluate: _positiveInt(process.env.SPORE_ZENDRIVER_EVALUATE_TIMEOUT_MS || config?.zendriverEvaluateTimeoutMs, 15000),
      click: _positiveInt(process.env.SPORE_ZENDRIVER_INTERACTION_TIMEOUT_MS || config?.zendriverInteractionTimeoutMs, 15000),
      type: _positiveInt(process.env.SPORE_ZENDRIVER_INTERACTION_TIMEOUT_MS || config?.zendriverInteractionTimeoutMs, 15000),
      scroll: _positiveInt(process.env.SPORE_ZENDRIVER_INTERACTION_TIMEOUT_MS || config?.zendriverInteractionTimeoutMs, 10000),
      status: _positiveInt(process.env.SPORE_ZENDRIVER_STATUS_TIMEOUT_MS || config?.zendriverStatusTimeoutMs, 5000),
      close: _positiveInt(process.env.SPORE_ZENDRIVER_CLOSE_TIMEOUT_MS || config?.zendriverCloseTimeoutMs, 10000),
      shutdown: _positiveInt(process.env.SPORE_ZENDRIVER_CLOSE_TIMEOUT_MS || config?.zendriverCloseTimeoutMs, 10000),
    };
  }

  isRunning() {
    return this._running;
  }

  async execute(input) {
    const action = (input.action || '').toLowerCase();
    switch (action) {
      case 'launch': return await this._launch(input);
      case 'navigate': return await this._navigate(input);
      case 'click': return await this._click(input);
      case 'type': return await this._type(input);
      case 'screenshot': return await this._screenshot();
      case 'scroll': return await this._scroll(input);
      case 'evaluate': return await this._evaluate(input);
      case 'tab_open': return await this._tabOpen(input);
      case 'tab_list': return await this._tabList();
      case 'tab_switch': return await this._tabSwitch(input);
      case 'tab_close': return await this._tabClose(input);
      case 'snapshot': return await this._snapshot(input);
      case 'close': return await this._close();
      case 'status': return await this._status();
      default:
        return { error: `Unknown browser action: ${action}. Use: launch, navigate, click, type, screenshot, scroll, evaluate, tab_open, tab_list, tab_switch, tab_close, close, status` };
    }
  }

  async _tabOpen(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const url = input.url || 'about:blank';
    if (url !== 'about:blank') {
      const blocked = getBlockedUrlError(url);
      if (blocked) return { error: blocked };
    }
    return await this._send('tab_open', { url });
  }

  async _tabList() {
    if (!this._running) return { error: 'Browser not launched.' };
    return await this._send('tab_list', {});
  }

  async _tabSwitch(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    if (input.index === undefined || input.index === null) {
      return { error: 'Missing required parameter: index' };
    }
    return await this._send('tab_switch', { index: input.index });
  }

  async _tabClose(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const payload = (input.index === undefined || input.index === null) ? {} : { index: input.index };
    return await this._send('tab_close', payload);
  }

  // Lazy import — same module web_fetch uses. ESM-only, can't require()
  // from CJS, so we cache the dynamic import after first call.
  async _loadAgentFetch() {
    if (this._agentFetchModule !== undefined) return this._agentFetchModule;
    try {
      this._agentFetchModule = await import('@teng-lin/agent-fetch');
    } catch (e) {
      this.log.warn(`[browser:zendriver] @teng-lin/agent-fetch import failed: ${e.message}`);
      this._agentFetchModule = null;
    }
    return this._agentFetchModule;
  }

  async _snapshot(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const max_html = Number(input.max_html) || 500_000;
    const r = await this._send('snapshot', { max_html });
    if (r?.error) return r;
    const s = r.structured || {};
    // Run the same Readability pipeline web_fetch uses on the live
    // outerHTML. Falls back to no-content gracefully if the lib fails
    // — the agent still gets the structured DOM list, which is the
    // primary value of snapshot.
    let content = null;
    try {
      const mod = await this._loadAgentFetch();
      if (mod?.extractFromHtml && r.html) {
        const ext = await mod.extractFromHtml(r.html, { url: s.url });
        if (ext) {
          const md = ext.markdown ? String(ext.markdown).slice(0, Number(input.max_content) || 6000) : null;
          content = {
            method: ext.method || null,
            markdown: md,
            excerpt: ext.excerpt ? String(ext.excerpt).slice(0, 600) : null,
            byline: ext.byline || null,
            siteName: ext.siteName || null,
            lang: ext.lang || null,
          };
        }
      }
    } catch (e) {
      this.log.warn(`[browser:zendriver] snapshot extract failed: ${e.message}`);
    }
    return {
      status: 'snapshot',
      url: s.url,
      title: s.title,
      lang: s.lang,
      viewport: s.viewport,
      interactive: s.interactive,
      interactive_total: s.interactive_total,
      interactive_truncated: (s.interactive_total || 0) > (s.interactive?.length || 0),
      headings: s.headings,
      content,
      html_truncated: !!r.html_truncated,
    };
  }

  async _launch(input) {
    if (this._running) {
      return { status: 'already_running', message: 'Zendriver browser is already open. Use navigate to go to a URL, or close first.', preview: 'snapshot' };
    }

    const url = input.url || 'about:blank';
    if (url !== 'about:blank') {
      const blocked = getBlockedUrlError(url);
      if (blocked) return { error: blocked };
    }

    const width = input.width || 1280;
    const height = input.height || 720;

    const launched = await this._send('launch', { url: 'about:blank', width, height });
    if (launched?.error || url === 'about:blank') return launched;

    const navigated = await this._send('navigate', { url });
    if (navigated?.error) {
      return {
        ...launched,
        status: 'launched',
        navigation_error: navigated.error,
        warning: `Browser launched, but initial navigation failed: ${navigated.error}`,
      };
    }
    return {
      ...launched,
      status: 'launched',
      navigation_status: navigated.status,
      url: navigated.url,
      title: navigated.title,
      warning: navigated.warning,
    };
  }

  async _navigate(input) {
    if (!this._running) return { error: 'Browser not launched. Call browser with action:"launch" first.' };
    const url = input.url;
    if (!url) return { error: 'Missing required parameter: url' };
    const blocked = getBlockedUrlError(url);
    if (blocked) return { error: blocked };
    return await this._send('navigate', { url });
  }

  async _click(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const selector = input.selector;
    if (!selector) return { error: 'Missing required parameter: selector' };
    return await this._send('click', { selector });
  }

  async _type(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const selector = input.selector;
    const text = input.text;
    if (!selector || text === undefined) return { error: 'Missing required parameters: selector, text' };
    return await this._send('type', { selector, text });
  }

  async _screenshot() {
    if (!this._running) return { error: 'Browser not launched.' };
    return await this._send('screenshot', {});
  }

  async _scroll(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const direction = (input.direction || 'down').toLowerCase();
    const amount = input.amount || 500;
    return await this._send('scroll', { direction, amount });
  }

  async _evaluate(input) {
    if (!this._running) return { error: 'Browser not launched.' };
    const expression = input.expression;
    if (!expression) return { error: 'Missing required parameter: expression' };
    return await this._send('evaluate', { expression });
  }

  async _close() {
    if (!this._proc || !this._running) {
      return { status: 'not_running', message: 'No browser to close.' };
    }
    let result;
    try { result = await this._send('close', {}); }
    catch (e) { result = { status: 'closed', warning: e.message }; }
    // Tear the helper subprocess down too — without this the python
    // helper stays alive across reset cycles, and any code change to
    // zendriver_browser.py that lands between sessions doesn't take
    // effect until the whole node process restarts. The helper is
    // cheap to respawn on next launch.
    try { await this._send('shutdown', {}); } catch {}
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch {}
    }
    this._running = false;
    return result;
  }

  async _status() {
    if (!this._proc) {
      return { status: 'not_running', preview: 'snapshot', screencast: false };
    }
    try {
      return await this._send('status', {});
    } catch (e) {
      return { status: 'not_running', preview: 'snapshot', screencast: false, error: e.message };
    }
  }

  async _ensureHelper() {
    if (this._proc) {
      if (this._readyPromise) await this._readyPromise;
      return;
    }

    const helperPath = path.join(__dirname, '..', 'helper', 'browser_helper.py');
    this._stderr = '';
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    this._proc = spawn('python3', [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this._stdout = readline.createInterface({ input: this._proc.stdout });
    this._stdout.on('line', (line) => this._handleLine(line));

    this._proc.stderr.on('data', (chunk) => {
      this._stderr += chunk.toString('utf8');
      if (this._stderr.length > 8000) this._stderr = this._stderr.slice(-8000);
    });

    this._proc.on('error', (err) => {
      this._failStartup(new Error(`Zendriver helper spawn failed: ${err.message}`));
      this._teardownProcess();
    });

    this._proc.on('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      const err = new Error(`Zendriver helper exited with ${detail}${this._stderr ? `: ${this._stderr.trim()}` : ''}`);
      this._failStartup(err);
      for (const pending of this._pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this._pending.clear();
      const wasRunning = this._running;
      this._teardownProcess();
      if (wasRunning) {
        this._running = false;
        this._broadcast({ type: 'browser:closed' });
      }
    });

    await this._readyPromise;
  }

  _failStartup(err) {
    if (this._readyReject) {
      this._readyReject(err);
      this._readyReject = null;
      this._readyResolve = null;
      this._readyPromise = null;
    }
  }

  _resolveStartup() {
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
      this._readyReject = null;
      this._readyPromise = null;
    }
  }

  _teardownProcess() {
    if (this._stdout) {
      this._stdout.removeAllListeners();
      this._stdout.close();
      this._stdout = null;
    }
    this._proc = null;
    this._stderr = '';
    this._readyResolve = null;
    this._readyReject = null;
    this._readyPromise = null;
  }

  _handleLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.log.warn(`[browser:${this.name}] Invalid helper output: ${e.message}`);
      return;
    }

    if (msg.event) {
      this._handleEvent(msg);
      return;
    }

    if (msg.id === undefined || msg.id === null) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.resolve({ error: msg.error });
      return;
    }
    pending.resolve(msg.result || {});
  }

  _handleEvent(msg) {
    switch (msg.event) {
      case 'ready':
        this._resolveStartup();
        return;
      case 'open':
        this._running = true;
        this._broadcast({ type: 'browser:open' });
        return;
      case 'closed':
        this._running = false;
        this._broadcast({ type: 'browser:closed' });
        return;
      case 'frame': {
        if (!msg.data) return;
        const jpegBuffer = Buffer.from(msg.data, 'base64');
        const header = {
          type: 'browser:frame',
          w: msg.width || 800,
          h: msg.height || 600,
        };
        if (msg.quality) header.quality = msg.quality;
        this._broadcast(encodeBrowserFrame(header, jpegBuffer), true);
        return;
      }
      case 'log': {
        const level = ['error', 'warn', 'info', 'debug'].includes(msg.level) ? msg.level : 'info';
        this.log[level](`[browser:${this.name}] ${msg.message}`);
        return;
      }
      default:
        return;
    }
  }

  _timeoutFor(action) {
    return this._timeoutsMs[action] || this._defaultTimeoutMs;
  }

  _forceStopHelper(reason) {
    const proc = this._proc;
    if (!proc) return;
    const wasRunning = this._running;
    this.log.warn(`[browser:${this.name}] Restarting helper after ${reason}`);

    for (const [id, pending] of this._pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Zendriver helper was restarted: ${reason}`));
      this._pending.delete(id);
    }

    this._running = false;
    this._teardownProcess();
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      } catch {}
    }, 2000).unref?.();
    if (wasRunning) this._broadcast({ type: 'browser:closed' });
  }

  async _send(action, payload) {
    await this._ensureHelper();
    if (!this._proc) {
      throw new Error('Zendriver helper is not running.');
    }

    const id = this._nextId++;
    const envelope = JSON.stringify({ id, action, ...payload });
    const timeoutMs = this._timeoutFor(action);

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._forceStopHelper(`${action} timed out after ${timeoutMs}ms`);
        reject(new Error(`Zendriver helper timed out while handling ${action} after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      this._proc.stdin.write(envelope + '\n', (err) => {
        if (!err) return;
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`Zendriver helper write failed: ${err.message}`));
      });
    });
  }

  async destroy() {
    if (!this._proc) return;
    try {
      if (this._running) {
        try { await this._send('close', {}); } catch (e) { this.log.warn('[zendriver-browser-backend] _send failed: ' + e.message); }
      }
      try { await this._send('shutdown', {}); } catch (e) { this.log.warn('[zendriver-browser-backend] _send failed: ' + e.message); }
      this._proc.kill('SIGTERM');
    } catch (e) { this.log.warn('[zendriver-browser-backend] _send failed: ' + e.message); }
  }
}

module.exports = ZendriverBrowserBackend;
