'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const { getBlockedUrlError, encodeBrowserFrame } = require('./browser-common');

class ZendriverBrowserBackend {
  constructor(log, broadcastFn) {
    this.name = 'zendriver';
    this.log = log;
    this._broadcast = broadcastFn;
    this._proc = null;
    this._stdout = null;
    this._stderr = '';
    this._pending = new Map();
    this._nextId = 1;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._running = false;
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
      case 'close': return await this._close();
      case 'status': return await this._status();
      default:
        return { error: `Unknown browser action: ${action}. Use: launch, navigate, click, type, screenshot, scroll, evaluate, close, status` };
    }
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

    return await this._send('launch', { url, width, height });
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
    return await this._send('close', {});
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

    const helperPath = path.join(__dirname, 'zendriver_browser.py');
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

  async _send(action, payload) {
    await this._ensureHelper();
    if (!this._proc) {
      throw new Error('Zendriver helper is not running.');
    }

    const id = this._nextId++;
    const envelope = JSON.stringify({ id, action, ...payload });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Zendriver helper timed out while handling ${action}.`));
      }, 120000);

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
