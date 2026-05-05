// longmemeval plugin — wraps the LongMemEval benchmark runner.
//
// Registers four web routes under /api/plugins/longmemeval/* (run,
// status, results, cancel), a frontend asset that ships the HUD UI
// (HTML + CSS + JS bundled into one self-installing module), and a
// dock item so operators can launch it from the canvas.
//
// All the previously-core integration is reached via api._appContext
// (see other complex plugins like spore-code and the LLM providers
// for the same pattern). When the plugin is uninstalled, the routes,
// dock item, and frontend asset all disappear.

const fs = require('fs');
const path = require('path');
const { coreRequire } = require('../core-require');

let RunnerModule = null;
function getRunner() {
  if (!RunnerModule) RunnerModule = require('./lib/runner');
  return RunnerModule;
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });
}

module.exports = function register(api) {
  const log = api.getLogger();
  const ctx = api._appContext;

  // POST /run — start a benchmark run
  api.registerWebRoute('POST', '/run', async (req, res) => {
    try {
      const tools = ctx?.tools;
      if (!tools) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'core tools not available' }));
        return;
      }

      const existing = tools._benchmarkRunner;
      if (existing && !['done', 'error', 'cancelled', 'idle'].includes(existing.phase)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Benchmark already running', phase: existing.phase }));
        return;
      }

      const body = await readJsonBody(req);
      const {
        mode = 'standard',
        variant = 'oracle',
        maxQuestions = 500,
        maxSessions = 10,
        skipIngestion = false,
        forceReeval = false,
        learnerModel,
        answerModel,
        questionTypes,
      } = body;

      const registry = tools._graphRegistry;
      if (!registry) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Multi-graph registry not available' }));
        return;
      }

      const graphEvents = coreRequire('graph/events');
      const prevSlug = registry.getActiveSlug();
      let slug;
      if (skipIngestion) {
        slug = prevSlug;
      } else {
        slug = registry.create(
          `LongMemEval ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          `LongMemEval benchmark (${variant})`,
        );
        tools.switchGraph(slug);
        graphEvents.emit('change', { op: 'graph:switched', slug, source: 'benchmark' });
      }

      const { LongMemEvalRunner } = getRunner();
      const webGw = ctx?.tools?.gateway || ctx?.gateways?.getGateway?.('web');
      const broadcast = webGw?.broadcast?.bind(webGw) || (() => {});

      const runner = new LongMemEvalRunner({
        config: ctx.config,
        graph: ctx.graph,
        learner: tools.learner,
        maintainer: tools._maintainer || null,
        llmClient: tools.llmClient,
        log,
        broadcast,
        learnerModel: learnerModel || undefined,
        answerModel: answerModel || undefined,
      });
      tools._benchmarkRunner = runner;
      tools._benchmarkPrevSlug = prevSlug;

      runner.run({
        mode,
        variant,
        maxQuestions,
        maxSessions,
        skipIngestion,
        forceReeval,
        questionTypes: questionTypes || null,
      }).catch((e) => {
        log.error(`Runner error: ${e.message}`);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slug, prevSlug, mode, variant, maxQuestions, maxSessions }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // GET /status — current phase/progress
  api.registerWebRoute('GET', '/status', async (_req, res) => {
    const tools = ctx?.tools;
    const runner = tools?._benchmarkRunner;
    const status = runner ? runner.getStatus() : { phase: 'idle' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  });

  // GET /available-models — flat list of models from every configured
  // provider, in the same `<provider>/<id>` (or bare for anthropic)
  // string format the rest of the codebase uses for config.casualModel
  // / normalModel / etc. The HUD dropdowns are populated from this
  // (so newly-added providers/models show up without any plugin edit).
  // Each entry includes the matching `ref` to send back as
  // `learnerModel` / `answerModel` on /run, plus `contextLength` and
  // `label` for grouped <optgroup> rendering.
  api.registerWebRoute('GET', '/available-models', async (_req, res) => {
    try {
      const mgr = ctx?.tools?._pluginManager;
      if (!mgr) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'plugin manager not available' }));
        return;
      }
      const cfg = ctx?.config || {};
      const out = [];
      const providers = mgr.getProviders?.() || [];
      const customProvider = providers.find(p => p.name === 'custom');
      // Resolve in parallel — listModels typically does a network round
      // trip, so a slow provider doesn't block the others. Built-in
      // providers (anthropic/openai/gemini/openrouter/zai/local) fall
      // back to env / host config / plugin slot for credentials when
      // body is empty. The 'custom' provider is special: each prefix
      // (bfl, glm, qwen, kimi, …) has its own baseUrl/apiKey under
      // config.customProviders.<name>, so we have to fan out per entry.
      const probes = [];
      for (const p of providers) {
        if (p.name === 'custom') continue; // handled separately below
        probes.push((async () => {
          try {
            if (p.isConfigured && !p.isConfigured(cfg)) return;
          } catch { return; }
          if (typeof p.listModels !== 'function') return;
          let result;
          try { result = await p.listModels({}); } catch { return; }
          const models = (result?.models || []).filter(m => m?.id);
          for (const m of models) {
            out.push({
              provider: p.name,
              label: p.label || p.name,
              id: m.id,
              ref: (p.name === 'anthropic') ? m.id : `${p.name}/${m.id}`,
              contextLength: m.contextLength || 0,
            });
          }
        })());
      }
      // Custom-prefix providers: iterate the configured prefixes and
      // call the custom provider's listModels with each one's URL/key.
      if (customProvider && typeof customProvider.listModels === 'function') {
        for (const [name, entry] of Object.entries(cfg.customProviders || {})) {
          if (!entry?.url) continue;
          probes.push((async () => {
            let result;
            try {
              result = await customProvider.listModels({
                baseUrl: entry.url,
                apiKey: entry.key || '',
                authHeader: entry.authHeader || 'bearer',
              });
            } catch { return; }
            const models = (result?.models || []).filter(m => m?.id);
            for (const m of models) {
              out.push({
                provider: name,
                label: name,
                id: m.id,
                ref: `${name}/${m.id}`,
                contextLength: m.contextLength || 0,
              });
            }
          })());
        }
      }
      await Promise.all(probes);
      out.sort((a, b) =>
        a.label.localeCompare(b.label) ||
        (b.contextLength - a.contextLength) ||
        a.id.localeCompare(b.id)
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: out,
        current: {
          casual: cfg.casualModel || null,
          normal: cfg.normalModel || null,
          planner: cfg.plannerModel || null,
          learner: cfg.learnerModel || null,
        },
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // GET /results — last completed run's saved results
  api.registerWebRoute('GET', '/results', async (_req, res) => {
    try {
      const cfg = ctx?.config || {};
      const graphDir = path.dirname(cfg.graphDbPath || '/data/graph.db');
      const resultsPath = path.join(graphDir, 'longmemeval-results.json');
      const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ empty: true }));
    }
  });

  // POST /cancel — stop the runner + restore the prior graph
  api.registerWebRoute('POST', '/cancel', async (_req, res) => {
    const tools = ctx?.tools;
    const runner = tools?._benchmarkRunner;
    if (runner) {
      runner.cancel();
      if (tools._benchmarkPrevSlug && tools._graphRegistry) {
        try {
          tools.switchGraph(tools._benchmarkPrevSlug);
          const graphEvents = coreRequire('graph/events');
          graphEvents.emit('change', {
            op: 'graph:switched',
            slug: tools._benchmarkPrevSlug,
            source: 'benchmark-cancel',
          });
        } catch (e) {
          log.warn(`Failed to switch back: ${e.message}`);
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  // The HUD UI ships as a single self-installing JS file under
  // static/longmemeval.js. The plugin manager exposes it at
  // /api/plugins/longmemeval/static/longmemeval.js and graph-viewer
  // boots it via the /api/plugins/frontend-assets manifest.
  api.registerFrontendAsset('longmemeval.js');

  // Settings pane — the operator-facing launcher lives under
  // Settings → Plugins → LongMemEval Benchmark. Clicking the button
  // opens the same HUD the legacy tools-menu item used to launch.
  // window.__lmeOpen is defined by the frontend asset above once the
  // plugin's script loads (it injects the HUD HTML lazily).
  api.registerSettingsPane({
    title: 'LongMemEval Benchmark',
    description:
      'Long-term memory benchmark. The first run downloads the chosen variant from HuggingFace. Each run is wrapped in a fresh ephemeral graph so it doesn\'t pollute your real memory. Best with Enhanced Recall enabled.',
    html: `
      <button type="button"
              class="settings-btn-secondary"
              onclick="window.__lmeOpen && window.__lmeOpen()">
        Run benchmark
      </button>
      <div class="settings-note" style="margin-top:6px;opacity:0.65">
        Opens the LongMemEval HUD overlaid on the canvas — pick a variant, model, and start.
      </div>
    `,
  });

  log.info('Plugin ready — 4 routes + HUD asset + dock item registered.');
};
