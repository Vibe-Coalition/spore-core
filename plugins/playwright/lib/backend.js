'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getBlockedUrlError, encodeBrowserFrame } = require('../../browser-core/lib/url-block');

class PlaywrightBrowserBackend {
  constructor({ log, broadcast, config } = {}) {
    this.name = 'playwright';
    this.log = log;
    this._broadcast = broadcast;
    this._config = config || null;
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
      case 'tab_open': return await this._tabOpen(input);
      case 'tab_list': return await this._tabList();
      case 'tab_switch': return await this._tabSwitch(input);
      case 'tab_close': return await this._tabClose(input);
      case 'snapshot': return await this._snapshot(input);
      case 'close': return await this._close();
      case 'status': return this._status();
      default:
        return { error: `Unknown browser action: ${action}. Use: launch, navigate, click, type, screenshot, scroll, evaluate, snapshot, tab_open, tab_list, tab_switch, tab_close, close, status` };
    }
  }

  async _loadAgentFetch() {
    if (this._agentFetchModule !== undefined) return this._agentFetchModule;
    try {
      this._agentFetchModule = await import('@teng-lin/agent-fetch');
    } catch (e) {
      this.log.warn(`[browser:playwright] @teng-lin/agent-fetch import failed: ${e.message}`);
      this._agentFetchModule = null;
    }
    return this._agentFetchModule;
  }

  _loadSnapshotPayload() {
    if (this._snapshotJs) return this._snapshotJs;
    // Shared with the zendriver backend — single source of truth for
    // the in-page DOM walk so both backends emit identical interactive[]
    // / headings[] shape.
    const sharedPath = path.join(__dirname, '..', '..', 'browser-core', 'lib', 'snapshot-payload.js');
    this._snapshotJs = fs.readFileSync(sharedPath, 'utf8');
    return this._snapshotJs;
  }

  async _snapshot(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const max_html = Number(input.max_html) || 500_000;
    let s;
    try {
      // Same JS the zendriver backend runs — shared file guarantees
      // identical interactive[]/headings[] shape across backends.
      s = await this._page.evaluate(`(${this._loadSnapshotPayload()})`);
    } catch (e) {
      return { error: `snapshot evaluate failed: ${e.message}` };
    }
    let html = '';
    try { html = await this._page.content(); } catch {}
    const html_truncated = html.length > max_html;
    if (html_truncated) html = html.slice(0, max_html);

    let content = null;
    try {
      const mod = await this._loadAgentFetch();
      if (mod?.extractFromHtml && html) {
        const ext = await mod.extractFromHtml(html, { url: s.url });
        if (ext) {
          content = {
            method: ext.method || null,
            markdown: ext.markdown ? String(ext.markdown).slice(0, Number(input.max_content) || 6000) : null,
            excerpt: ext.excerpt ? String(ext.excerpt).slice(0, 600) : null,
            byline: ext.byline || null,
            siteName: ext.siteName || null,
            lang: ext.lang || null,
          };
        }
      }
    } catch (e) {
      this.log.warn(`[browser:playwright] snapshot extract failed: ${e.message}`);
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
      html_truncated,
    };
  }

  // Tab management — Playwright models tabs as `pages` inside a
  // browser `context`. We keep `this._page` as the active page;
  // tab_open creates a new page in the same context, tab_switch
  // reassigns this._page, tab_close closes the target page.

  _pages() {
    return this._page?.context()?.pages() || [];
  }

  _pageIndex(target) {
    const pages = this._pages();
    target = target || this._page;
    return pages.indexOf(target);
  }

  async _tabOpen(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const url = input.url || 'about:blank';
    if (url !== 'about:blank') {
      const blocked = getBlockedUrlError(url);
      if (blocked) return { error: blocked };
    }
    try {
      const ctx = this._page.context();
      const newPage = await ctx.newPage();
      if (url !== 'about:blank') {
        await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      this._page = newPage;
      await this._page.bringToFront();
      const title = await this._page.title();
      return {
        status: 'tab_opened',
        index: this._pageIndex(),
        url: this._page.url(),
        title,
        active: true,
        tab_count: this._pages().length,
      };
    } catch (e) {
      return { error: `tab_open failed: ${e.message}` };
    }
  }

  async _tabList() {
    if (!this._page) return { error: 'Browser not launched.' };
    const pages = this._pages();
    const tabs = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      let title = '';
      try { title = await p.title(); } catch {}
      tabs.push({ index: i, url: p.url(), title, active: (p === this._page) });
    }
    return { status: 'tabs_listed', tabs, active_index: this._pageIndex(), tab_count: pages.length };
  }

  async _tabSwitch(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    if (input.index === undefined || input.index === null) {
      return { error: 'Missing required parameter: index' };
    }
    const pages = this._pages();
    const idx = Number(input.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
      return { error: `tab index ${idx} out of range (have ${pages.length} tabs)` };
    }
    this._page = pages[idx];
    try { await this._page.bringToFront(); } catch {}
    let title = '';
    try { title = await this._page.title(); } catch {}
    return { status: 'tab_switched', index: idx, url: this._page.url(), title, tab_count: pages.length };
  }

  async _tabClose(input) {
    if (!this._page) return { error: 'Browser not launched.' };
    const pages = this._pages();
    if (pages.length <= 1) {
      return { error: 'Cannot close the last tab — use action:close to stop the browser instead.' };
    }
    let target = this._page;
    let idx = this._pageIndex(target);
    if (input.index !== undefined && input.index !== null) {
      idx = Number(input.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
        return { error: `tab index ${idx} out of range (have ${pages.length} tabs)` };
      }
      target = pages[idx];
    }
    let newActive = null;
    if (target === this._page) {
      const newIdx = idx > 0 ? idx - 1 : 1;
      newActive = pages[newIdx];
    }
    try { await target.close(); } catch (e) { return { error: `tab_close failed: ${e.message}` }; }
    if (newActive) {
      this._page = newActive;
      try { await this._page.bringToFront(); } catch {}
    }
    return {
      status: 'tab_closed',
      closed_index: idx,
      active_index: this._pageIndex(),
      tab_count: this._pages().length,
    };
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
      // Use real per-character keydown/keypress/input/change events.
      // page.fill() (the previous implementation) skips that whole path
      // — it sets the input's value directly and fires a single input
      // event, which is fast for tests but a textbook bot signal.
      // pressSequentially focuses + types char-by-char via the same
      // CDP keyboard channel a real user produces.
      const locator = this._page.locator(selector);
      await locator.first().focus({ timeout: 10000 });
      // Clear any existing value first (Ctrl/Cmd+A, Delete) so we don't
      // append to whatever's in the field.
      await locator.first().press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await this._page.keyboard.press('Delete');
      await locator.first().pressSequentially(String(text), { delay: 12, timeout: 30000 });
      return { status: 'typed', selector, textLength: String(text).length, via: 'keyboard' };
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
      // page.mouse.wheel dispatches a real WheelEvent (CDP
      // Input.dispatchMouseEvent type=mouseWheel). Has to be over a
      // scrollable area, so park the mouse at the viewport centre
      // first — without that, wheel events at (0,0) sometimes fail to
      // reach scroll containers under fixed headers.
      const vp = this._page.viewportSize() || { width: 1280, height: 720 };
      await this._page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
      const deltaY = direction === 'up' ? -amount : amount;
      await this._page.mouse.wheel(0, deltaY);
      await this._page.waitForTimeout(300);
      return { status: 'scrolled', direction, amount, via: 'wheel' };
    } catch (e) {
      // Fallback for pages where wheel dispatch fails (PDFs, some
      // chrome:// urls). Still better to retry via JS than to error.
      try {
        const delta = direction === 'up' ? -amount : amount;
        await this._page.evaluate((d) => window.scrollBy(0, d), delta);
        await this._page.waitForTimeout(300);
        return { status: 'scrolled', direction, amount, via: 'js_fallback', warning: e.message };
      } catch (e2) {
        return { error: `Scroll failed: ${e2.message}` };
      }
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
