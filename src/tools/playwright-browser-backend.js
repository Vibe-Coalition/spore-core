'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getBlockedUrlError, encodeBrowserFrame } = require('./browser-common');

class PlaywrightBrowserBackend {
  constructor(log, broadcastFn) {
    this.name = 'playwright';
    this.log = log;
    this._broadcast = broadcastFn;
    this._browser = null;
    this._page = null;
    this._cdp = null;
    this._screencastActive = false;
  }

  isRunning() {
    return !!this._browser;
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
      case 'status': return this._status();
      default:
        return { error: `Unknown browser action: ${action}. Use: launch, navigate, click, type, screenshot, scroll, evaluate, close, status` };
    }
  }

  async _launch(input) {
    if (this._browser) {
      return { status: 'already_running', message: 'Browser is already open. Use navigate to go to a URL, or close first.' };
    }

    let pw;
    try {
      pw = require('playwright-core');
    } catch {
      try {
        pw = require('playwright');
      } catch {
        return {
          error: 'Browser tool unavailable — Playwright is not installed in this container. ' +
                 'It will be available after the next image rebuild. Do NOT try to install it manually.'
        };
      }
    }

    const url = input.url || 'about:blank';
    if (url !== 'about:blank') {
      const blocked = getBlockedUrlError(url);
      if (blocked) return { error: blocked };
    }
    const width = input.width || 1280;
    const height = input.height || 720;

    try {
      this._browser = await pw.chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          `--window-size=${width},${height}`,
        ],
      });

      const context = await this._browser.newContext({
        viewport: { width, height },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      this._page = await context.newPage();

      if (url !== 'about:blank') {
        await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      await this._startScreencast();

      const title = await this._page.title();
      this.log.info(`[browser:${this.name}] Launched — ${url} (${width}x${height}), screencast active`);
      this._broadcast({ type: 'browser:open' });

      return {
        status: 'launched',
        url: this._page.url(),
        title,
        viewport: { width, height },
        preview: 'screencast',
        message: 'Browser launched with live preview streaming to the control panel.',
      };
    } catch (e) {
      await this._cleanup();
      const msg = e.message || String(e);
      if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
        return { error: 'Chromium browser not found. Run: npx playwright install chromium' };
      }
      return { error: `Browser launch failed: ${msg}` };
    }
  }

  async _startScreencast() {
    if (!this._page || this._screencastActive) return;
    try {
      this._cdp = await this._page.context().newCDPSession(this._page);
      await this._cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 45,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 2,
      });
      this._screencastActive = true;

      this._cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        try {
          this._cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          const buf = Buffer.from(data, 'base64');
          this._broadcastFrame({
            type: 'browser:frame',
            w: metadata.deviceWidth || 800,
            h: metadata.deviceHeight || 600,
          }, buf);
        } catch (e) { this.log.warn('[playwright-browser-backend] _cdp.send failed: ' + e.message); }
      });
    } catch (e) {
      this.log.warn(`[browser:${this.name}] Screencast start failed: ${e.message}`);
    }
  }

  _broadcastFrame(header, jpegBuffer) {
    if (!this._broadcast) return;
    this._broadcast(encodeBrowserFrame(header, jpegBuffer), true);
  }

  async _navigate(input) {
    if (!this._page) return { error: 'Browser not launched. Call browser with action:"launch" first.' };
    const url = input.url;
    if (!url) return { error: 'Missing required parameter: url' };
    const blocked = getBlockedUrlError(url);
    if (blocked) return { error: blocked };

    try {
      await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await this._page.title();
      this.log.info(`[browser:${this.name}] Navigate — ${url} (${title})`);
      return { status: 'navigated', url: this._page.url(), title };
    } catch (e) {
      return { error: `Navigation failed: ${e.message}` };
    }
  }

  async _click(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const selector = input.selector;
    if (!selector) return { error: 'Missing required parameter: selector' };

    try {
      await this._page.click(selector, { timeout: 10000 });
      await this._page.waitForTimeout(500);
      const title = await this._page.title();
      return { status: 'clicked', selector, url: this._page.url(), title };
    } catch (e) {
      return { error: `Click failed on "${selector}": ${e.message}` };
    }
  }

  async _type(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const selector = input.selector;
    const text = input.text;
    if (!selector || text === undefined) return { error: 'Missing required parameters: selector, text' };

    try {
      await this._page.fill(selector, text, { timeout: 10000 });
      return { status: 'typed', selector, textLength: text.length };
    } catch (e) {
      return { error: `Type failed on "${selector}": ${e.message}` };
    }
  }

  async _screenshot() {
    if (!this._page) return { error: 'Browser not launched.' };
    try {
      const buf = await this._page.screenshot({ type: 'jpeg', quality: 80 });
      const filePath = this._nextScreenshotPath();
      fs.writeFileSync(filePath, buf);
      this._broadcastFrame({ type: 'browser:frame', quality: 'high' }, buf);
      return {
        status: 'screenshot_taken',
        url: this._page.url(),
        title: await this._page.title(),
        filePath,
        message: 'High-quality screenshot saved to disk and sent to the control panel.',
      };
    } catch (e) {
      return { error: `Screenshot failed: ${e.message}` };
    }
  }

  async _scroll(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const direction = (input.direction || 'down').toLowerCase();
    const amount = input.amount || 500;

    try {
      const delta = direction === 'up' ? -amount : amount;
      await this._page.evaluate((d) => window.scrollBy(0, d), delta);
      await this._page.waitForTimeout(300);
      return { status: 'scrolled', direction, amount };
    } catch (e) {
      return { error: `Scroll failed: ${e.message}` };
    }
  }

  async _evaluate(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const expression = input.expression;
    if (!expression) return { error: 'Missing required parameter: expression' };

    try {
      const result = await this._page.evaluate(expression);
      const serialized = JSON.stringify(result);
      return {
        status: 'evaluated',
        result: serialized && serialized.length > 4000 ? serialized.substring(0, 4000) + '...' : result,
      };
    } catch (e) {
      return { error: `Evaluate failed: ${e.message}` };
    }
  }

  async _close() {
    if (!this._browser) return { status: 'not_running', message: 'No browser to close.' };
    try {
      await this._cleanup();
      this.log.info(`[browser:${this.name}] Closed`);
      this._broadcast({ type: 'browser:closed' });
      return { status: 'closed', message: 'Browser closed and live preview stopped.' };
    } catch (e) {
      return { error: `Close failed: ${e.message}` };
    }
  }

  _status() {
    if (!this._browser) return { status: 'not_running' };
    return {
      status: 'running',
      url: this._page?.url() || 'unknown',
      screencast: this._screencastActive,
      preview: 'screencast',
    };
  }

  async _cleanup() {
    this._screencastActive = false;
    if (this._cdp) {
      try { await this._cdp.send('Page.stopScreencast'); } catch (e) { this.log.warn('[playwright-browser-backend] _cdp.send failed: ' + e.message); }
      try { await this._cdp.detach(); } catch (e) { this.log.warn('[playwright-browser-backend] _cdp.detach failed: ' + e.message); }
      this._cdp = null;
    }
    if (this._browser) {
      try { await this._browser.close(); } catch { /* silent: best-effort close */ }
      this._browser = null;
    }
    this._page = null;
  }

  async destroy() {
    await this._cleanup();
  }

  _nextScreenshotPath() {
    const preferredDir = process.env.SPORE_BROWSER_SCREENSHOT_DIR || '/workspace/browser-screenshots';
    const dir = this._ensureDir(preferredDir) || this._ensureDir(path.join(os.tmpdir(), 'spore-browser-screenshots'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `browser-${this.name}-${stamp}.jpg`);
  }

  _ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return null;
    }
  }
}

module.exports = PlaywrightBrowserBackend;
