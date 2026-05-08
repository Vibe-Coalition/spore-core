'use strict';

// browser-core plugin — registers the `browser` tool and routes its
// actions to whichever backend plugin (zendriver, playwright, …) the
// operator has selected. The tool description below is the one the
// agent sees in its system prompt; keep it accurate to the action
// surface that the backends actually implement (verified by
// tests/browser-eventlog/probe-events.py).

const BrowserTool = require('./lib/tool');

module.exports = function register(api) {
  const ctx = api._appContext || {};
  const log = api.getLogger ? api.getLogger() : (ctx.log || console);

  // Reference-node SQL — install creates ref-browser-automation with
  // backend-agnostic aspects; uninstall drops the whole node.
  // schemaVersion bumps re-run install.sql against existing graphs.
  // v2 — legacy-cleanup sweep for pre-plugin `extracted_with='seed'`
  //       rows on the ref-browser-automation node.
  // v3 — moved the spore-self "Can launch a headless browser…"
  //       capability attribute + the spore→ref-browser-automation edge
  //       from seed-graph.sql into this plugin (with cleanup of the
  //       seed-tagged duplicates on existing graphs).
  // v4 — cross-node touchpoint on ref-web-search.workflow_pattern:
  //       "escalate to browser when web_fetch returns suspicious
  //       content" — only present while browser-core is installed.
  // v5 — web-panel live preview / screenshot delivery docs moved out
  //       of the always-included prompt into ref-browser-automation.
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 5,
  });

  // Lazy: build the BrowserTool the first time the agent calls us, so
  // we read the live backend list (post-init) and don't pin a config
  // snapshot from before other plugins finished registering.
  const toolsByScope = new Map();
  function browserScopeKey(toolCtx = {}) {
    const platform = String(toolCtx.platform || 'unknown').toLowerCase();
    const channel = String(toolCtx.channelId || toolCtx.sessionKey || 'no-channel');
    const user = String(toolCtx.userId || toolCtx.userName || 'anonymous');
    return `${platform}\u0000${channel}\u0000${user}`;
  }
  function routeFromCtx(toolCtx = {}) {
    return {
      sessionKey: toolCtx.sessionKey || null,
      channelId: toolCtx.channelId || null,
      platform: toolCtx.platform || null,
      userId: toolCtx.userId || null,
    };
  }
  function makeScopedBroadcast(toolCtx = {}) {
    const route = routeFromCtx(toolCtx);
    return (data, isBinary) => {
      try {
        if (isBinary) {
          const delivered = ctx.tools?._broadcastSessionBinary?.(route, data, {
            fallbackGlobal: false,
            logPrefix: 'browser-core',
          });
          return delivered || 0;
        }
        const payload = data && typeof data === 'object' && !Array.isArray(data)
          ? {
              ...data,
              sessionKey: route.sessionKey,
              channelId: route.channelId,
              platform: route.platform,
              userId: route.userId,
            }
          : data;
        const delivered = ctx.tools?._broadcastSessionEvent?.(route, payload, {
          fallbackGlobal: false,
          logPrefix: 'browser-core',
        });
        return delivered || 0;
      } catch (e) { log.warn('[browser-core] scoped broadcast failed: ' + e.message); }
      return 0;
    };
  }
  function getTool(toolCtx = {}) {
    const scopeKey = browserScopeKey(toolCtx);
    if (toolsByScope.has(scopeKey)) return toolsByScope.get(scopeKey);
    const tool = new BrowserTool({
      log,
      broadcast: makeScopedBroadcast(toolCtx),
      config: ctx.config,
      pluginManager: ctx.tools?._pluginManager || null,
    });
    toolsByScope.set(scopeKey, tool);
    return tool;
  }

  // Default-backend hint baked into the description at register time.
  // The string ends up in the system prompt, so we keep it short and
  // factually grounded — anti-bot specifics, action style, and the
  // discovery hierarchy are also reinforced via prompt-sections.js +
  // ref-browser-automation node, so we don't repeat them here.
  const defaultBackend = ctx.config?.browserBackend || 'zendriver';
  const description =
    `Control a persistent Chromium browser for web scraping, testing, form automation, or visual verification. Backends are provided by browser-backend plugins (currently zendriver: stealth-patched, hides navigator.webdriver, the right backend for sites with anti-bot detection; playwright: live screencast, easier debugging, more detectable). Default follows this instance's browser setting (${defaultBackend}) unless another backend is already active.

ACTION GUIDE — pick the most realistic action for what you're doing. Anti-bot stacks (Reddit, Cloudflare, Akamai, etc.) fingerprint *how* events arrive, not just what. Always prefer:
  • snapshot — STRUCTURED page read. Returns {url, title, interactive: [{kind, selector, text, visible, in_viewport, …}], headings: [...], content: {markdown, excerpt}}. Use as your menu of actions instead of rolling your own evaluate-based discovery.
  • click(selector) — synthesizes real mousedown/mouseup/click events at the element's screen coords.
  • type(selector, text) — synthesizes real keydown/keypress/input events one character at a time. Use for ALL form fields. Triggers React/Vue onChange handlers correctly.
  • scroll(direction, amount) — uses wheel events.
  • navigate(url) — full page navigation in the active tab.
  • tab_open(url) — opens url in a NEW tab and switches to it. Use when you need to keep the current page (search results → result page → back to results).
  • tab_list — returns [{index, url, title, active}] for every open tab.
  • tab_switch(index) — make tab N the active one. Subsequent click/type/etc. operate on it.
  • tab_close(index?) — close tab N (default: current). Errors on the last tab — use close to stop the whole browser.
  • screenshot — visual verification of the active tab; also writes a JPG and returns filePath.
  • evaluate(expression) — RAW JS execution on the active tab. ONLY use for *read-only* inspection. NEVER use evaluate to set input values (el.value = "x"), simulate clicks (el.click()), or fire submits — these bypass real event dispatch and are a top-3 bot-detection signal.
  • status — inspect current backend / executable / session / active tab / tab count.
  • launch / close — lifecycle. Browser persists across tool calls; launch once.

Common mistake: probing the DOM with 5+ evaluate calls instead of just snapshotting + clicking/typing what you see.`;

  api.registerTool('browser', {
    namespaced: false,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['launch', 'navigate', 'click', 'type', 'screenshot', 'scroll', 'evaluate', 'snapshot', 'tab_open', 'tab_list', 'tab_switch', 'tab_close', 'close', 'status'],
          description: 'Browser action. For DISCOVERY: prefer `snapshot` — returns structured interactive[] + clean content in one call. For INTERACTION: prefer click/type over evaluate — JS-driven el.value/el.click bypass real input events and are detected as bot behaviour. Use tab_* actions for multi-tab workflows.',
        },
        backend: {
          type: 'string',
          description: 'Browser backend selector (e.g. "zendriver", "playwright"). Omit to use the instance default or the currently-active backend.',
        },
        url:        { type: 'string', description: 'URL to open (for launch / navigate / tab_open)' },
        selector:   { type: 'string', description: 'CSS selector (for click/type). Be specific.' },
        text:       { type: 'string', description: 'Text to type. Sent as real keystrokes, one char at a time.' },
        direction:  { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default: down)' },
        amount:     { type: 'number', description: 'Scroll pixels (default: 500)' },
        expression: { type: 'string', description: 'JavaScript expression to evaluate. READ-ONLY uses only.' },
        index:      { type: 'number', description: 'Tab index (for tab_switch / tab_close). 0-based.' },
        width:      { type: 'number', description: 'Viewport width (default: 1280, for launch only)' },
        height:     { type: 'number', description: 'Viewport height (default: 720, for launch only)' },
      },
      required: ['action'],
    },
    available: (toolCtx = {}) => toolCtx.platform !== 'cli',
    execute: async (input, toolCtx = {}) => getTool(toolCtx).execute(input || {}),
  });

  api.onShutdown(async () => {
    for (const [scopeKey, tool] of toolsByScope) {
      try { await tool.destroy(); } catch (e) { log.warn(`[browser-core] destroy failed for ${scopeKey}: ${e.message}`); }
    }
    toolsByScope.clear();
  });

  log.info('[plugin:browser-core] Plugin ready — `browser` tool registered, routes to backend plugins.');
};
