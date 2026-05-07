#!/usr/bin/env node
/**
 * app.js — SPORE Application Bootstrap
 *
 * Boots the agent and connects all gateways (Discord, Telegram, Slack, Web).
 * Initializes the knowledge graph, session manager, tool system, learner,
 * maintainer, plugin system, and health/invoke API server.
 *
 * `index.js` remains as a thin compatibility wrapper.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadConfig, createLogger } = require('./config');
loadConfig();

const { GraphContext, setEmbedderManager } = require('./graph');
const { SessionManager } = require('./agent');
const { ToolSystem } = require('./tools');
const { AgentLoop } = require('./agent');
const { Learner, Maintainer, Janitor, ChannelDistiller, BackupWorker, GraphMaintenanceCoordinator, GeneralKbResearchWorker } = require('./workers');
const { GatewayManager } = require('./gateways');
const { PluginManager } = require('./plugins');
const { RuntimeJobQueue } = require('./runtime');

async function ensureGraph(config, log) {
  const dbPath = config.graphDbPath;
  if (fs.existsSync(dbPath)) return;

  log.info(`[boot] Graph DB not found at ${dbPath} — seeding fresh database...`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  const seedPath = path.join(__dirname, 'seed-graph.sql');
  if (!fs.existsSync(seedPath)) {
    log.warn('[boot] seed-graph.sql not found — starting with empty graph');
    new DatabaseSync(dbPath).close();
    return;
  }

  let sql = fs.readFileSync(seedPath, 'utf8');
  const agentId = config.agentId || 'spore';
  const agentName = config.displayName || agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  sql = sql.replace(/AGENT_ID/g, agentId).replace(/AGENT_NAME/g, agentName);

  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  const count = db.prepare('SELECT count(*) as c FROM nodes').get().c;
  db.close();
  log.info(`[boot] Graph seeded with ${count} nodes for agent "${agentId}"`);
}

/**
 * Upsert a graph node with accurate web-serving capability info.
 * Runs at every boot so the agent always knows its own public URLs.
 */
function updateWebCapabilityNode(config, db, log) {
  try {
    const agentId = config.agentId;
    const nodeId = `${agentId}-web`;

    // Build public URL — prefer SPORE_PUBLIC_URL, fall back to legacy ingress vars
    let publicUrl = config.publicUrl || null;
    if (!publicUrl && config.ingressDomain) {
      const protocol = config.ingressHttps ? 'https' : 'http';
      const rawPath = (config.ingressPath || '').replace(/\/$/, '');
      publicUrl = `${protocol}://${config.ingressDomain}${rawPath || ''}`;
    }
    let graphViewerUrl = publicUrl ? `${publicUrl}/graph` : null;

    // Build human-readable attribute list
    const attrs = [];

    if (config.webPort) {
      attrs.push(`Web server is running on internal port ${config.webPort}.`);
    } else {
      attrs.push('Web server is not enabled. Set SPORE_WEB_PORT to activate it, or use the web_serve tool.');
    }

    let domain = config.ingressDomain || null;
    let https = config.ingressHttps ?? false;
    let urlPath = (config.ingressPath || '').replace(/\/$/, '');
    if (publicUrl) {
      try {
        const u = new URL(publicUrl);
        if (!domain) domain = u.hostname;
        if (!config.ingressHttps) https = u.protocol === 'https:';
        if (!urlPath && u.pathname && u.pathname !== '/') urlPath = u.pathname.replace(/\/$/, '');
      } catch (e) { console.warn('[app] URL failed: ' + e.message); }
    }

    if (publicUrl) {
      attrs.push(`Public URL: ${publicUrl}`);
      if (domain) attrs.push(`Base domain: ${domain}`);
      if (urlPath) attrs.push(`URL path prefix: ${urlPath}`);
      attrs.push(`Ingress mode: ${config.ingressMode || 'traefik'} (${https ? 'HTTPS/TLS' : 'HTTP'}).`);
    } else if (config.webPort) {
      attrs.push('No public domain configured — reachable on LAN or via direct port only.');
    }

    if (graphViewerUrl) {
      attrs.push(`Graph constellation viewer: ${graphViewerUrl}`);
    } else if (config.webPort) {
      attrs.push('Graph viewer is available at /graph relative to the web server root.');
    }

    if (config.webAuthUser) {
      attrs.push(`Web interface requires HTTP Basic Auth (username: ${config.webAuthUser}).`);
    } else if (config.webPort) {
      attrs.push('Web interface has no authentication — consider setting SPORE_WEB_AUTH_USER and SPORE_WEB_AUTH_PASS.');
    }

    if (!attrs.length) {
      attrs.push('No web services are configured for this agent.');
    }

    // Upsert node
    const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId);
    if (!existing) {
      db.prepare(
        'INSERT INTO nodes (id, label, type, description, importance, mentions, extracted_with, extracted_at) VALUES (?, ?, ?, ?, 8, 1, ?, ?)'
      ).run(
        nodeId,
        'Web Services',
        'capability',
        publicUrl ? `Web interface and API for ${config.displayName}. Public URL: ${publicUrl}` : `Web server configuration for ${config.displayName}.`,
        'boot',
        new Date().toISOString()
      );
    } else {
      db.prepare(
        'UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(
        publicUrl ? `Web interface and API for ${config.displayName}. Public URL: ${publicUrl}` : `Web server configuration for ${config.displayName}.`,
        nodeId
      );
    }

    // Upsert aspect — delete old attributes so stale config doesn't linger
    let aspRow = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, 'web_services');
    if (!aspRow) {
      db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 9, ?)').run(nodeId, 'web_services', 'boot');
      aspRow = { id: db.prepare('SELECT last_insert_rowid() as id').get().id };
    }
    // Replace all attributes with fresh boot data
    db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(aspRow.id);
    for (const attr of attrs) {
      db.prepare('INSERT INTO attributes (aspect_id, content, importance, source) VALUES (?, ?, 8, ?)').run(aspRow.id, attr, 'boot');
    }

    // Ensure edge: agentId -> nodeId (knows/has)
    const edgeExists = db.prepare('SELECT rowid FROM edges WHERE source = ? AND target = ? AND type = ?').get(agentId, nodeId, 'has_capability');
    if (!edgeExists) {
      const targetExists = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId);
      const sourceExists = db.prepare('SELECT id FROM nodes WHERE id = ?').get(agentId);
      if (targetExists && sourceExists) {
        db.prepare("INSERT INTO edges (source, target, type, weight, extracted_with, confidence) VALUES (?, ?, ?, 1, 'boot', 'extracted')").run(agentId, nodeId, 'has_capability');
      }
    }

    log.info(`[boot] Web capability node updated: ${nodeId}${publicUrl ? ` → ${publicUrl}` : ' (no public URL)'}`);
  } catch (e) {
    log.warn(`[boot] Could not update web capability node: ${e.message}`);
  }
}

function migrateReferenceNodes(db, log) {
  cleanupRetiredReferenceNodes(db, log, 'active');

  try {
    const staleMarker = db.prepare(
      "SELECT a.id FROM aspects a JOIN attributes at ON at.aspect_id = a.id WHERE a.node_id = 'ref-api-keys' AND a.name = 'access_patterns' AND at.content LIKE '%/data/.env%' LIMIT 1"
    ).get();
    if (!staleMarker) {
      // Skip the stale-content cleanup below (nothing to clean), but still
      // fall through to the idempotent ref-node migrations at the end of the
      // function that need to run on every boot.
      throw new Error('__skip_stale__');
    }

    log.info('[boot] Migrating stale reference nodes to vault/web_serve backend...');

    const apiAspect = db.prepare("SELECT id FROM aspects WHERE node_id = 'ref-api-keys' AND name = 'access_patterns'").get();
    if (apiAspect) {
      db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(apiAspect.id);
      const ins = db.prepare("INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, 'seed', 'seed')");
      ins.run(apiAspect.id, 'API keys live in the secure vault on the manager — encrypted at rest, never in plain .env files', 9);
      ins.run(apiAspect.id, 'Use env_manage action:"vault_list" to see available keys. Use web_fetch with credential:"KEY_NAME" for authenticated API calls (key injected server-side, never exposed)', 9);
      ins.run(apiAspect.id, 'For scripts needing a raw key: env_manage action:"vault_get" key="X" — writes to a temp file that auto-deletes in 5 minutes', 8);
      ins.run(apiAspect.id, 'web_serve action:"backend" auto-injects ALL vault keys as env vars in your backend process — no vault_get needed for backends', 9);
    }

    const webAspect = db.prepare("SELECT id FROM aspects WHERE node_id = 'ref-web-architecture' AND name = 'user_app_proxy'").get();
    if (webAspect) {
      db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(webAspect.id);
      const ins = db.prepare("INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, 'seed', 'seed')");
      ins.run(webAspect.id, 'Use web_serve action:"backend" command:"node server.js" — it allocates a port, injects vault keys, proxies routes, and persists across restarts automatically', 10);
      ins.run(webAspect.id, 'The web gateway proxies /api/* and any non-file routes to your backend automatically', 9);
      ins.run(webAspect.id, 'Backend gets APP_PORT and PORT env vars — listen on that port, not a hardcoded one', 9);
      ins.run(webAspect.id, "Frontend MUST use relative fetch paths: fetch('api/endpoint') with credentials:'include'. NEVER use absolute paths like fetch('/api/endpoint') — Traefik prefix stripping makes them fail", 10);
    }

    log.info('[boot] Reference nodes migrated successfully');
  } catch (e) {
    if (e && e.message === '__skip_stale__') {
      // expected: stale content already cleaned up, keep going
    } else {
      log.warn(`[boot] Reference node migration failed: ${e.message}`);
    }
  }

  // ref-tailscale moved to plugins/tailscale/sql/install.sql and
  // ref-compute-cluster moved to plugins/compute-cluster/sql/install.sql.
  // Plugin manager handles their lifecycle now — no boot-time
  // migration needed.

  // Email ref node moved to plugins/email/ (extracted in phase 2.2).
  // The original src/migrate-ref-email.sql stays on disk as audit/restore
  // until the plugin is verified across all SPORE instances.

// Local search tools ref node (idempotent; runs every boot). Tells the
  // agent that grep + glob exist as native tools so it stops shelling out
  // to exec+grep/find. New as of the grep/glob tool catalog addition.
  try {
    const migPath = path.join(__dirname, 'migrate-ref-search-tools.sql');
    if (fs.existsSync(migPath)) {
      const sql = fs.readFileSync(migPath, 'utf8');
      const before = db.prepare("SELECT COUNT(*) AS c FROM aspects WHERE node_id='ref-search-tools'").get()?.c || 0;
      db.exec(sql);
      const after = db.prepare("SELECT COUNT(*) AS c FROM aspects WHERE node_id='ref-search-tools'").get()?.c || 0;
      if (after > before) log.info(`[boot] Search-tools ref migrated: +${after - before} aspects`);
    }
  } catch (e) {
    log.warn(`[boot] Search-tools ref migration failed: ${e.message}`);
  }

  // Acorn-context (5 ref bundles incl. graphcorn-discovery) extracted to
  // plugins/spore-code/ in phase 2.3a. Source SQL files stay on disk as
  // audit / restore until verified across all SPORE instances.

// Web search & fetch reference node — gives the agent a per-tool
  // ref node for web_search/web_fetch (alongside ref-search-tools)
  // AND a cross-reference on ref-acorn-context.client_routing so
  // acorn agents see "use web_search for current info" alongside the
  // local-routing hints.
  try {
    const migPath = path.join(__dirname, 'migrate-ref-web-search.sql');
    if (fs.existsSync(migPath)) {
      const sql = fs.readFileSync(migPath, 'utf8');
      const before = db.prepare("SELECT COUNT(*) AS c FROM aspects WHERE node_id='ref-web-search'").get()?.c || 0;
      db.exec(sql);
      const after = db.prepare("SELECT COUNT(*) AS c FROM aspects WHERE node_id='ref-web-search'").get()?.c || 0;
      if (after > before) log.info(`[boot] ref-web-search migrated: +${after - before} aspects`);
    }
  } catch (e) {
    log.warn(`[boot] ref-web-search migration failed: ${e.message}`);
  }

  // Cron runtime reference node — includes the local proactive trigger
  // endpoint so scheduled jobs can notify chat without carrying this recipe
  // in every prompt.
  try {
    const migPath = path.join(__dirname, 'migrate-ref-cron-runtime.sql');
    if (fs.existsSync(migPath)) {
      const sql = fs.readFileSync(migPath, 'utf8');
      const before = db.prepare(`
        SELECT COUNT(*) AS c
        FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
        WHERE asp.node_id='ref-cron-runtime'
          AND asp.name='cron'
          AND a.content LIKE 'Cron and background jobs can notify%'
      `).get()?.c || 0;
      db.exec(sql);
      const after = db.prepare(`
        SELECT COUNT(*) AS c
        FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
        WHERE asp.node_id='ref-cron-runtime'
          AND asp.name='cron'
          AND a.content LIKE 'Cron and background jobs can notify%'
      `).get()?.c || 0;
      if (after > before) log.info('[boot] ref-cron-runtime proactive trigger migrated');
    }
  } catch (e) {
    log.warn(`[boot] ref-cron-runtime migration failed: ${e.message}`);
  }

  // General tool workflow reference node. This is static operational
  // knowledge, so it belongs in ref nodes rather than the always-included
  // prompt.
  try {
    const migPath = path.join(__dirname, 'migrate-ref-tool-workflows.sql');
    if (fs.existsSync(migPath)) {
      const sql = fs.readFileSync(migPath, 'utf8');
      const before = db.prepare("SELECT COUNT(*) AS c FROM aspects WHERE node_id='ref-tool-workflows'").get()?.c || 0;
      db.exec(sql);
      const after = db.prepare("SELECT COUNT(*) AS c FROM aspects WHERE node_id='ref-tool-workflows'").get()?.c || 0;
      if (after > before) log.info(`[boot] ref-tool-workflows migrated: +${after - before} aspects`);
    }
  } catch (e) {
    log.warn(`[boot] ref-tool-workflows migration failed: ${e.message}`);
  }

  // Web chat / panel behavior docs. The live prompt keeps only short
  // pointers; this migration carries the detailed source-of-truth rules.
  try {
    const migPath = path.join(__dirname, 'migrate-ref-web-chat-ui.sql');
    if (fs.existsSync(migPath)) {
      const sql = fs.readFileSync(migPath, 'utf8');
      const before = db.prepare(`
        SELECT COUNT(*) AS c
        FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
        WHERE asp.node_id='ref-image-display'
          AND a.content LIKE 'In web chat, reply with%'
      `).get()?.c || 0;
      db.exec(sql);
      const after = db.prepare(`
        SELECT COUNT(*) AS c
        FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
        WHERE asp.node_id='ref-image-display'
          AND a.content LIKE 'In web chat, reply with%'
      `).get()?.c || 0;
      if (after > before) log.info('[boot] ref-web-chat-ui migrated');
    }
  } catch (e) {
    log.warn(`[boot] ref-web-chat-ui migration failed: ${e.message}`);
  }
}

function cleanupRetiredReferenceNodes(db, log, graphLabel = 'graph') {
  try {
    const retiredIds = ['ref-code-viewer', 'ref-cross-agent-messaging', 'ref-token-efficiency'];
    const before = db.prepare(
      `SELECT COUNT(*) AS c FROM nodes WHERE id IN (${retiredIds.map(() => '?').join(',')})`
    ).get(...retiredIds)?.c || 0;

    db.exec(`
      DELETE FROM edges
       WHERE source IN ('ref-code-viewer', 'ref-cross-agent-messaging', 'ref-token-efficiency')
          OR target IN ('ref-code-viewer', 'ref-cross-agent-messaging', 'ref-token-efficiency');

      DELETE FROM attributes
       WHERE aspect_id IN (
         SELECT id FROM aspects
          WHERE node_id IN ('ref-code-viewer', 'ref-cross-agent-messaging')
             OR node_id = 'ref-token-efficiency'
       );

      DELETE FROM aspects
       WHERE node_id IN ('ref-code-viewer', 'ref-cross-agent-messaging', 'ref-token-efficiency');

      DELETE FROM aliases
       WHERE node_id IN ('ref-code-viewer', 'ref-cross-agent-messaging', 'ref-token-efficiency');

      DELETE FROM nodes
       WHERE id IN ('ref-code-viewer', 'ref-cross-agent-messaging', 'ref-token-efficiency');

      DELETE FROM attributes
       WHERE aspect_id IN (
         SELECT id FROM aspects
          WHERE node_id = 'ref-tool-workflows'
            AND name = 'tool_selection'
       )
         AND (
           content LIKE 'The user controls code-viewer mode%'
           OR content LIKE 'The code viewer is automatic:%'
         );

      UPDATE attributes
         SET content = 'Use delegate_task for sub-agent work, spore_message for a configured multi-spore mesh, and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.'
       WHERE content = 'Use delegate_task for sub-agent work and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.';
    `);

    db.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection' ORDER BY id LIMIT 1),
             'In the web panel, read_file/write_file/edit_file automatically create code-viewer tabs; use file tools normally and do not build a custom viewer.',
             8, 'seed', 'seed'
       WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection')
         AND NOT EXISTS (
           SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
            WHERE asp.node_id = 'ref-tool-workflows'
              AND asp.name = 'tool_selection'
              AND a.content LIKE 'In the web panel, read_file/write_file/edit_file automatically create code-viewer tabs%'
         )
    `).run();

    db.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
             'Use delegate_task for sub-agent work, spore_message for a configured multi-spore mesh, and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.',
             8, 'seed', 'seed'
       WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking')
         AND NOT EXISTS (
           SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
            WHERE asp.node_id = 'ref-tool-workflows'
              AND asp.name = 'asking_waiting_tracking'
              AND a.content LIKE 'Use delegate_task for sub-agent work%do not create graph-inbox nodes%'
         )
    `).run();

    db.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency' ORDER BY id LIMIT 1),
             'Keep tool use lean: do not re-read files or docs you just used, do not refetch stable facts, and delegate genuinely heavy independent work.',
             8, 'seed', 'seed'
       WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency')
         AND NOT EXISTS (
           SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
            WHERE asp.node_id = 'ref-tool-workflows'
              AND asp.name = 'efficiency'
              AND a.content LIKE 'Keep tool use lean:%'
         )
    `).run();

    if (before > 0) {
      log.info(`[boot] Retired ${before} stale ref node(s) from ${graphLabel}`);
    }
  } catch (e) {
    log.warn(`[boot] Retired ref-node cleanup failed for ${graphLabel}: ${e.message}`);
  }
}

function cleanupRetiredReferenceNodesAcrossGraphs(graphRegistry, activeDb, log) {
  if (!graphRegistry?.list) return;
  const { DatabaseSync } = require('node:sqlite');
  const activePath = path.resolve(graphRegistry.getActiveDbPath?.() || '');

  for (const graph of graphRegistry.list()) {
    const dbPath = graph?.dbPath;
    if (!dbPath || !fs.existsSync(dbPath)) continue;
    const resolved = path.resolve(dbPath);
    const db = resolved === activePath ? activeDb : new DatabaseSync(resolved);
    try {
      cleanupRetiredReferenceNodes(db, log, graph.slug || resolved);
    } finally {
      if (resolved !== activePath) {
        try { db.close(); } catch {}
      }
    }
  }
}

async function boot() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  log.info('Spore Core v0.3.0 starting...');
  log.info(`Model: ${config.model}`);

  // Multi-graph registry — manages multiple knowledge graphs per spore
  const { GraphRegistry } = require('./graph/multi');
  const dataDir = path.dirname(config.graphDbPath);
  const graphRegistry = new GraphRegistry(dataDir, config, log);
  const activeDbPath = graphRegistry.init();

  if (activeDbPath) {
    config.graphDbPath = activeDbPath;
    process.env.GRAPH_DB_PATH = activeDbPath;
  }

  log.info(`Graph: ${config.graphDbPath} (active: ${graphRegistry.getActiveSlug()})`);

  await ensureGraph(config, log);

  const graph = new GraphContext(config, log);
  graph._graphRegistry = graphRegistry;
  if (!graph.init()) {
    log.error('Failed to initialize graph context engine. Exiting.');
    process.exit(1);
  }

  // Inject web-serving capability into graph so agent knows its own public URLs
  updateWebCapabilityNode(config, graph.db, log);
  migrateReferenceNodes(graph.db, log);
  cleanupRetiredReferenceNodesAcrossGraphs(graphRegistry, graph.db, log);

  const { MultiProvider } = require('./providers');

  // Pre-populate missing API keys from the manager vault
  try {
    await MultiProvider.populateFromVault(config, log);
  } catch (e) {
    log.warn(`[vault] Failed to load keys from vault: ${e.message}`);
  }

  // Pull LLM provider configs from manager (env vars take precedence)
  try {
    await MultiProvider.populateProvidersFromManager(config, log);
  } catch (e) {
    log.warn(`[providers] Failed to load providers from manager: ${e.message}`);
  }

  // OAuth token detection now lives in plugins/anthropic-provider —
  // it sets config._isOAuth at register time and on every config
  // change. Core no longer string-matches against vendor token shapes.
  const llmClient = new MultiProvider(config);
  log.info(`Provider cache initialized — main model backend: ${require('./providers').detectBackend(config.model, config)}`);

  const learner = new Learner(config, log, llmClient);
  learner._graphRegistry = graphRegistry;
  if (!learner.init()) log.warn('Learner failed to init — learning disabled.');

  const maintainer = new Maintainer(config, log, llmClient, learner.db);
  maintainer.ensureSchema();
  log.info('Maintainer initialized (gaps, reflections, stale-check, sparse-connect)');

  const janitor = new Janitor(config, log, llmClient, learner.db);
  janitor.ensureSchema();
  log.info(`Janitor initialized (mode=${config.janitorMode || 'moderate'}, interval=${config.janitorIntervalMinutes || 360}m)`);

  const channelDistiller = new ChannelDistiller(config, log, llmClient, learner, graphRegistry);
  log.info(`Channel distiller initialized (interval=${config.channelDistillerIntervalMinutes || 120}m, idle=${config.channelDistillerIdleMinutes || 45}m)`);

  const backup = new BackupWorker(config, log, learner.db, config.graphDbPath, graphRegistry);

  const graphMaintenance = new GraphMaintenanceCoordinator(config, log, llmClient, learner, graphRegistry, {
    maintainer,
    janitor,
    channelDistiller,
    backup,
  });
  log.info(`Graph maintenance coordinator initialized (interval=${config.graphMaintenanceIntervalMinutes || 120}m)`);

  const generalKbResearch = new GeneralKbResearchWorker(config, log, llmClient, learner, graphRegistry);
  log.info(`General KB research worker initialized (interval=${config.generalKbResearchIntervalHours || 24}h)`);

  const sessions = new SessionManager(config, log, learner);
  if (!sessions.init()) {
    log.error('Failed to initialize session manager. Exiting.');
    process.exit(1);
  }

  const tools = new ToolSystem(config, log, null, graph, llmClient);
  tools.learner = learner;
  tools._maintainer = maintainer;
  tools._janitor = janitor;
  tools._channelDistiller = channelDistiller;
  tools._backup = backup;
  tools._graphMaintenance = graphMaintenance;
  tools._generalKbResearch = generalKbResearch;
  tools._sessions = sessions;
  tools._graphRegistry = graphRegistry;

  const agent = new AgentLoop(config, log, graph, sessions, tools, learner);
  const agentReady = agent.init();
  if (!agentReady) {
    log.warn('Agent loop not initialized (missing API key?). Web panel will still be available — add your API key to .env and restart.');
  }
  agent.graphContext = graph;
  tools._agent = agent;
  generalKbResearch.agent = agent;

  let runtimeQueue = null;
  if (config.runtimeQueueEnabled !== false) {
    runtimeQueue = new RuntimeJobQueue(config, log, sessions, {
      agent,
      tools,
      learner,
      maintainer,
      janitor,
      backup,
      graphMaintenance,
      generalKbResearch,
      channelDistiller,
    });
    tools._jobQueue = runtimeQueue;
    agent._jobQueue = runtimeQueue;
    generalKbResearch.queue = runtimeQueue;
  } else {
    log.warn('Runtime job queue disabled; falling back to legacy direct worker execution.');
  }

  const runRuntimeWorker = (kind, payload, meta, fallback) => {
    if (runtimeQueue?.submitWorkerJob) return runtimeQueue.submitWorkerJob(kind, payload, meta);
    return typeof fallback === 'function' ? fallback() : null;
  };

  const gateways = new GatewayManager(config, log, agent, tools);
  graph._gatewayManager = gateways;

  // Plugin system — opt-in. Plugins run as full-privilege Node code with no
  // sandbox, so loading is gated behind SPORE_PLUGINS_ENABLED.
  // Two discovery roots:
  //   • Bundled (read-only at runtime): config.pluginsDir, defaults to <repo>/plugins.
  //     Ships with the docker image; vetted plugins live here.
  //   • User (operator-writable): config.pluginsUserDir, defaults to
  //     <workspace>/plugins. Operator drops or git-clones plugins here.
  const plugins = new PluginManager(config, log);
  if (config.pluginsEnabled) {
    // Bundled plugins live next to app.js in the docker image (`/app/plugins`).
    // In the host source tree they're a sibling of src/ (`<repo>/plugins`).
    // Try both; prefer config override → in-tree sibling → repo sibling.
    const bundledCandidates = [
      config.pluginsDir,
      path.join(__dirname, 'plugins'),
      path.join(__dirname, '..', 'plugins'),
    ].filter(Boolean);
    const bundledDir = bundledCandidates.find(p => { try { return require('fs').existsSync(p); } catch { return false; } }) || bundledCandidates[1];
    const userDir = config.pluginsUserDir
      || (config.workspacePath ? path.join(config.workspacePath, 'plugins') : null);
    plugins.setDiscoveryDirs({ bundled: bundledDir, user: userDir });
    if (bundledDir) await plugins.loadAll(bundledDir, { source: 'bundled' });
    if (userDir)    await plugins.loadAll(userDir,    { source: 'user' });
    await plugins.initAll({ config, log, graph, sessions, tools, agent, learner, gateways });
    if (plugins.plugins.size > 0) log.info(`[plugins] ${plugins.plugins.size} plugin(s) active`);
  } else {
    log.info('[plugins] Disabled (set SPORE_PLUGINS_ENABLED=true to enable). Plugins run unsandboxed with full process privileges.');
  }
  tools._pluginManager = plugins;
  agent._pluginManager = plugins;
  learner._pluginManager = plugins;
  maintainer._pluginManager = plugins;
  channelDistiller._pluginManager = plugins;
  // GraphContext._buildPluginPromptSections + _buildPluginSection both gate
  // on this — without it, every plugin-contributed prompt section silently
  // disappears regardless of mode/registration. Was missed in phase 1 wiring.
  graph._pluginManager = plugins;

  // Wire the embedder walker so graph indexing + retrieval pick up
  // whichever embedder plugin is currently registered + configured.
  // Before this call, embedNode/embedText silently no-op — same shape
  // as the legacy GEMINI_API_KEY-not-set fallback.
  setEmbedderManager(plugins);

  // Wire the LLM-provider walker so createClientForModel routes
  // through registered provider plugins first. Until this lands, all
  // model strings dispatch through the legacy in-tree branches in
  // src/providers/index.js. Once provider plugins are extracted
  // (Phases B-E of the provider-extraction plan), those branches
  // disappear and core consults the manager exclusively.
  try {
    const { setProviderManager } = require('./providers');
    setProviderManager(plugins);
    log.info(`Provider ready — main model backend: ${require('./providers').detectBackend(config.model, config)}`);
  } catch (e) {
    log.warn(`[boot] setProviderManager failed: ${e.message}`);
  }

  if (runtimeQueue) {
    runtimeQueue.init();
    log.info(`Runtime job queue initialized (lanes=${Object.entries(runtimeQueue.laneLimits).map(([k, v]) => `${k}:${v}`).join(', ')})`);
  }

  const healthServer = startHealthServer(config, log, graph, sessions, gateways, learner, maintainer, tools, agent);

  try {
    await gateways.connectAll();
    tools.platformManager = gateways;
    // Wire the WS broadcaster so ask_user + plan-mode proposals can push
    // directly from the tools layer to the right operator's WS clients.
    const _webGw = gateways.getGateway?.('web') || tools.gateway;
    if (_webGw && typeof _webGw._broadcastToSessionKey === 'function') {
      tools._wsBroadcast = (sessionKey, payload) => _webGw._broadcastToSessionKey(sessionKey, payload);
    }
    if (typeof tools._wireWebGatewayBroadcaster === 'function') {
      tools._wireWebGatewayBroadcaster();
    }
    log.info('Spore Core is running.');
  } catch (e) {
    log.error('Failed to connect gateways:', e.message);
    process.exit(1);
  }

  // Sync any existing tools from workspace/tools/ into the graph
  try {
    const toolsDir = path.join(config.workspacePath || process.cwd(), 'tools');
    if (fs.existsSync(toolsDir)) {
      const regPath = path.join(toolsDir, 'TOOLS_REGISTRY.json');
      let registry = {};
      try { registry = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch { /* silent: malformed JSON → fallback */ }

      // Also discover scripts not in the registry
      const scriptExts = ['.py', '.sh', '.js'];
      for (const f of fs.readdirSync(toolsDir)) {
        const ext = path.extname(f);
        if (!scriptExts.includes(ext)) continue;
        const name = path.basename(f, ext);
        if (!registry[name]) {
          const lang = ext === '.py' ? 'python' : ext === '.sh' ? 'bash' : 'node';
          registry[name] = { name, description: '', language: lang, path: path.join(toolsDir, f), usage: `exec: ${path.join(toolsDir, f)}` };
        }
      }

      let synced = 0;
      for (const t of Object.values(registry)) {
        tools._upsertToolNode(t.name, t.description, t.language, t.path, t.usage);
        synced++;
      }
      if (synced > 0) log.info(`[boot] Synced ${synced} tool(s) to graph`);
    }
  } catch (e) {
    log.warn(`[boot] Tool sync failed: ${e.message}`);
  }

  // Auto-start web server (+ backend if previously configured)
  if (config.webPort) {
    try {
      let savedDir;
      try { savedDir = fs.readFileSync(path.join(config.dataDir, '.web-serve-dir'), 'utf8').trim(); } catch (e) { console.warn('[app] fs.readFileSync failed: ' + e.message); }

      let backendCfg;
      try { backendCfg = JSON.parse(fs.readFileSync(path.join(config.dataDir, '.backend-config.json'), 'utf8')); } catch { /* silent: malformed JSON → fallback */ }

      if (backendCfg?.command) {
        const result = tools._webServeTool({
          action: 'backend',
          dir: backendCfg.dir || savedDir,
          command: backendCfg.command,
          command_dir: backendCfg.commandDir,
        });
        if (result.started) {
          log.info(`[web] Restored backend "${backendCfg.command}" on port ${result.backendPort}, ${(result.vaultKeysInjected || []).length} vault key(s)`);
        } else {
          log.warn(`[web] Backend restore failed: ${result.error || 'unknown'}`);
        }
      } else {
        const opts = { action: 'start' };
        if (savedDir) opts.dir = savedDir;
        const result = tools._webServeTool(opts);
        if (result.started) {
          log.info(`[web] Serving ${result.dir || 'web'} on port ${config.webPort}`);
        } else if (result.error) {
          log.warn(`[web] Could not auto-start web server: ${result.error}`);
        }
      }
      if (typeof tools._wireWebGatewayBroadcaster === 'function') {
        tools._wireWebGatewayBroadcaster();
      }
    } catch (e) {
      log.warn(`[web] Auto-start failed: ${e.message}`);
    }
  }

  // Connect to shared chatroom if manager URL is configured
  if (process.env.MANAGER_URL) {
    try {
      const { ChatroomGateway } = require('./gateways/chatroom');
      const chatroomGw = new ChatroomGateway(
        agent, config, log,
        process.env.MANAGER_URL,
        process.env.MANAGER_SERVICE_KEY || '',
      );
      chatroomGw._closed = true;
      tools._chatroomGateway = chatroomGw;
      log.info(`[chatroom] Gateway ready (disabled by default) — enable via control panel toggle`);
    } catch (e) {
      log.warn(`[chatroom] Failed to initialize chatroom gateway: ${e.message}`);
    }
  }

  // Restore persisted data pollers (delayed to let SSH sidecar connect)
  setTimeout(() => {
    try {
      if (!fs.existsSync(path.join(config.dataDir, '.data-pollers.json'))) return;
      const mgr = tools._ensureSSHManager();
      if (!mgr) { log.warn('[data-poller] Cannot restore pollers — SSH manager not available'); return; }
      if (!tools._dataPoller) {
        const { DataPoller } = require('./tools/data-poller');
        const auditFn = mgr.audit ? mgr.audit.bind(mgr) : () => {};
        tools._dataPoller = new DataPoller(mgr, log, auditFn, config.dataDir);
      }
      const result = tools._dataPoller.restore();
      if (result.restored > 0) {
        log.info(`[data-poller] Restored ${result.restored}/${result.total} poller(s) from previous session`);
      }
      if (result.errors) {
        for (const err of result.errors) log.warn(`[data-poller] Restore error: ${err}`);
      }
    } catch (e) {
      log.warn(`[data-poller] Restore failed: ${e.message}`);
    }
  }, 10000);

  // Restore persisted startup tasks (delayed to let app fully boot)
  setTimeout(() => {
    try {
      if (!fs.existsSync(path.join(config.dataDir, '.startup-tasks.json'))) return;
      const result = tools.restoreStartupTasks();
      if (result.restored > 0) {
        log.info(`[startup-tasks] Restoring ${result.restored}/${result.total} task(s) with their configured delays`);
      }
    } catch (e) {
      log.warn(`[startup-tasks] Restore failed: ${e.message}`);
    }
  }, 12000);

  // Fast sweep for agent-scheduled wakeups. The heartbeat runs too infrequently
  // (45m) to be useful for "wake me in 60–3600s" timers — they need a tight
  // poll. 10s gives a reasonable precision/overhead trade.
  const wakeupSweepTimer = setInterval(() => {
    try { tools.sweepWakeups?.(); } catch (e) { log.error('[wakeup-sweep] error:', e.message); }
  }, 10000);

  const heartbeatMs = (config.heartbeatIntervalMinutes || 45) * 60 * 1000;
  const heartbeatTimer = setInterval(async () => {
    log.info('[heartbeat] Running periodic tasks...');
    sessions.cleanupStaleSessions();

    let cycleSummary = null;
    try {
      if (config.maintainerIdleOnly && agent.activeRuns.size > 0) {
        log.info('[heartbeat] Skipping maintenance — conversations active');
      } else {
        cycleSummary = await runRuntimeWorker('maintenance.run', { opts: {} }, {
          lane: 'maintenance',
          priority: 25,
          route: 'heartbeat',
        }, () => maintainer.runMaintenance({}));
        if (config.graphMaintenanceEnabled !== false) {
          await runRuntimeWorker('graphMaintenance.run', { opts: { reason: 'heartbeat' } }, {
            lane: 'maintenance',
            priority: 22,
            route: 'heartbeat',
          }, () => graphMaintenance.run({ reason: 'heartbeat' }));
        }
      }
    } catch (e) {
      log.error('[heartbeat] Maintainer error:', e.message);
    }

    if (cycleSummary && config.proactive?.enabled) {
      try {
        dispatchProactive(cycleSummary);
      } catch (e) {
        log.error('[heartbeat] Proactive outreach error:', e.message);
      }
    }

    log.info(`[heartbeat] Learner: ${JSON.stringify(learner.getStats())} | Maintainer: ${JSON.stringify(maintainer.getStats())}`);
  }, heartbeatMs);

  async function dispatchProactive(cycleSummary) {
    const webGw = tools.gateway;

    const channelHints = [
      ...gateways.getActiveChannelHints(),
      ...(webGw?.getActiveChannelIds?.() || []).map(h => ({ ...h, _gw: 'web' })),
    ];

    const action = await maintainer.maybeProactiveAction(cycleSummary, channelHints);
    if (!action || action.action !== 'post') return;

    const hint = channelHints.find(h => h.id === action.channelId);
    const gwName = hint?._gw || null;

    if (gwName === 'web' && webGw?.injectProactivePrompt) {
      webGw.injectProactivePrompt(action.channelId, action.context, action.topic);
    } else if (gwName) {
      const gateway = gateways.getGateway(gwName);
      if (gateway?.injectProactivePrompt) {
        gateway.injectProactivePrompt(action.channelId, action.context, action.topic);
      }
    }
  }

  // First maintenance cycle after a 30-minute grace period (not on every restart)
  const maintainerDelay = (config.maintainerBootDelayMinutes || 5) * 60_000;
  log.info(`[maintainer] First cycle delayed ${Math.round(maintainerDelay / 60000)}m after boot`);
  setTimeout(async () => {
    try {
      const cycleSummary = await runRuntimeWorker('maintenance.run', { opts: {} }, {
        lane: 'maintenance',
        priority: 25,
        route: 'boot-maintenance',
      }, () => maintainer.runMaintenance({}));
      if (cycleSummary && config.proactive?.enabled) {
        dispatchProactive(cycleSummary);
      }
      if (config.graphMaintenanceEnabled !== false) {
        await runRuntimeWorker('graphMaintenance.run', { opts: { reason: 'boot' } }, {
          lane: 'maintenance',
          priority: 22,
          route: 'boot-maintenance',
        }, () => graphMaintenance.run({ reason: 'boot' }));
      }
    } catch (e) {
      log.error('[boot-maintenance] Error:', e.message);
    }
  }, maintainerDelay);

  // Janitor: separate interval from the maintainer
  const janitorIntervalMs = (config.janitorIntervalMinutes || 360) * 60_000;
  const janitorBootDelay = (config.janitorBootDelayMinutes || 8) * 60_000;
  const janitorTimer = setInterval(async () => {
    if (config.janitorEnabled === false) return;
    if (config.maintainerIdleOnly && agent.activeRuns.size > 0) return;
    try {
      await runRuntimeWorker('janitor.run', { opts: {} }, {
        lane: 'maintenance',
        priority: 20,
        route: 'janitor.interval',
      }, () => janitor.runJanitor({}));
    } catch (e) { log.error('[janitor] Interval error:', e.message); }
  }, janitorIntervalMs);
  log.info(`[janitor] Scheduled every ${Math.round(janitorIntervalMs / 60000)}m, first cycle in ${Math.round(janitorBootDelay / 60000)}m`);
  setTimeout(async () => {
    if (config.janitorEnabled === false) return;
    try {
      await runRuntimeWorker('janitor.run', { opts: {} }, {
        lane: 'maintenance',
        priority: 20,
        route: 'janitor.boot',
      }, () => janitor.runJanitor({}));
    } catch (e) { log.error('[boot-janitor] Error:', e.message); }
  }, janitorBootDelay);

  // Channel distiller: channel conversations do not have a reliable
  // session-end moment, so promote reusable lessons after an idle window.
  const channelDistillerIntervalMs = (config.channelDistillerIntervalMinutes || 120) * 60_000;
  const channelDistillerBootDelay = (config.channelDistillerBootDelayMinutes || 20) * 60_000;
  const channelDistillerTimer = setInterval(async () => {
    if (config.channelDistillerEnabled === false) return;
    if (config.maintainerIdleOnly && agent.activeRuns.size > 0) return;
    try {
      await runRuntimeWorker('channelDistill.run', { opts: {} }, {
        lane: 'background',
        priority: 12,
        route: 'channel-distill.interval',
      }, () => channelDistiller.run({}));
    } catch (e) { log.error('[channel-distill] Interval error:', e.message); }
  }, channelDistillerIntervalMs);
  log.info(`[channel-distill] Scheduled every ${Math.round(channelDistillerIntervalMs / 60000)}m, idle threshold ${config.channelDistillerIdleMinutes || 45}m, first cycle in ${Math.round(channelDistillerBootDelay / 60000)}m`);
  setTimeout(async () => {
    if (config.channelDistillerEnabled === false) return;
    try {
      await runRuntimeWorker('channelDistill.run', { opts: {} }, {
        lane: 'background',
        priority: 12,
        route: 'channel-distill.boot',
      }, () => channelDistiller.run({}));
    } catch (e) { log.error('[boot-channel-distill] Error:', e.message); }
  }, channelDistillerBootDelay);

  // General KB research is intentionally separate from graph maintenance.
  // It queues long web-research agent work on the background lane so the
  // maintenance lane can keep producing embeddings, clusters, and overviews.
  const generalKbResearchIntervalMs = Math.max(15 * 60_000, (Number(config.generalKbResearchIntervalHours) || 24) * 60 * 60_000);
  const generalKbResearchBootDelay = Math.max(15 * 60_000, maintainerDelay + 2 * 60_000);
  const runGeneralKbResearchCycle = async (reason) => {
    if (config.generalKbResearchEnabled === false) return;
    try {
      const result = await generalKbResearch.enqueue({ reason });
      if (result?.ok) log.info(`[general-kb-research] queued ${result.queued} node(s) (${reason})`);
      else if (result?.skipped) log.debug?.(`[general-kb-research] skipped ${result.skipped} (${reason})`);
      else if (result?.error) log.warn(`[general-kb-research] ${result.error}`);
    } catch (e) {
      log.error(`[general-kb-research] ${reason} error:`, e.message);
    }
  };
  const generalKbResearchTimer = setInterval(() => runGeneralKbResearchCycle('interval'), generalKbResearchIntervalMs);
  log.info(`[general-kb-research] Scheduled every ${Math.round(generalKbResearchIntervalMs / 60000)}m, first cycle in ${Math.round(generalKbResearchBootDelay / 60000)}m`);
  setTimeout(() => runGeneralKbResearchCycle('boot'), generalKbResearchBootDelay);

  const backupIntervalMs = Math.max(1, Number(config.graphBackupIntervalMinutes) || 60) * 60_000;
  const backupTimer = setInterval(async () => {
    if (config.graphBackupEnabled === false) return;
    try {
      await runRuntimeWorker('backup.run', { opts: { force: false } }, {
        lane: 'maintenance',
        priority: 15,
        route: 'backup.interval',
      }, () => backup.runBackups({ force: false }));
    } catch (e) { log.error('[backup] Interval error:', e.message); }
  }, backupIntervalMs);
  log.info(`[backup] Scheduled through runtime queue every ${Math.round(backupIntervalMs / 60000)}m, retention=${config.graphBackupRetention || 20}`);
  setTimeout(async () => {
    if (config.graphBackupEnabled === false) return;
    try {
      await runRuntimeWorker('backup.run', { opts: { force: false } }, {
        lane: 'maintenance',
        priority: 15,
        route: 'backup.boot',
      }, () => backup.runBackups({ force: false }));
    } catch (e) { log.error('[backup] boot snapshot error:', e.message); }
  }, 120_000);

  log.info(`Heartbeat scheduled every ${config.heartbeatIntervalMinutes || 45} minutes`);

  const shutdown = async (signal) => {
    log.info(`Received ${signal}, shutting down...`);
    try {
      clearInterval(heartbeatTimer);
      clearInterval(wakeupSweepTimer);
      clearInterval(janitorTimer);
      clearInterval(channelDistillerTimer);
      clearInterval(generalKbResearchTimer);
      clearInterval(backupTimer);
      try { runtimeQueue?.stop?.(); } catch (e) { console.warn('[app] runtimeQueue.stop failed: ' + e.message); }
      try { backup.stop(); } catch (e) { console.warn('[app] backup.stop failed: ' + e.message); }
      tools._killAllTracked();
      await plugins.shutdownAll();
      await gateways.disconnectAll();
      healthServer.close();
      sessions.close();
      learner.close();
      graph.close();
      log.info('Spore Core stopped cleanly.');
    } catch (e) {
      log.error('Error during shutdown:', e.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log.error('Uncaught exception:', e.message);
    log.error(e.stack);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason);
  });
}

function startHealthServer(config, log, graph, sessions, gateways, learner, maintainer, tools, agent) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    // POST /api/invoke — one-shot agent invocation for inter-spore orchestration
    if (req.url === '/api/invoke' && req.method === 'POST') {
      if (!config.managerServiceKey) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invoke API disabled — MANAGER_SERVICE_KEY not configured' }));
        return;
      }
      {
        const provided = (req.headers['x-service-key'] || '').trim();
        const expected = config.managerServiceKey;
        if (!provided || provided.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized — valid X-Service-Key header required' }));
          return;
        }
      }
      try {
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', c => { data += c; if (data.length > 100_000) reject(new Error('Payload too large')); });
          req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
          req.on('error', reject);
        });

        const { message, context, timeout } = body;
        if (!message || typeof message !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "message" string' }));
          return;
        }

        const timeoutMs = Math.min((timeout || 120) * 1000, 300_000);
        const start = Date.now();
        const invokeSessionKey = `invoke:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        const fromSpore = body.from || null;
        const invokeLines = [
          `[INTER-SPORE MESSAGE${fromSpore ? ` from ${fromSpore}` : ''}]`,
          context ? `Context: ${context}` : null,
          '',
          message,
          '',
          '---',
          'IMPORTANT: If this message asks you to tell, notify, inform, or relay something to your user,',
          'you MUST call the notify_user tool to actually deliver it. Your text response here goes back',
          'to the sending spore only — your user will NOT see it unless you use notify_user.',
        ].filter(v => v !== null).join('\n');

        const agentOpts = {
          content: invokeLines,
          channelId: invokeSessionKey,
          channelName: 'invoke',
          sessionKey: invokeSessionKey,
          userId: fromSpore || 'orchestrator',
          userName: fromSpore || 'Orchestrator',
          isDm: true,
          trigger: 'invoke',
          platform: 'api',
        };

        const resultPromise = tools?._jobQueue?.submitAgentTurn
          ? tools._jobQueue.submitAgentTurn(agentOpts, {
              lane: 'interactive',
              priority: 95,
              route: 'api.invoke',
              allowInterjection: false,
            })
          : agent.processMessage(agentOpts);

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Invoke timed out')), timeoutMs)
        );

        const result = await Promise.race([resultPromise, timeoutPromise]);

        // Clean up the ephemeral session
        try { sessions.clearSession(invokeSessionKey); } catch (e) { console.warn('[app] sessions.clearSession failed: ' + e.message); }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response: result.text || null,
          model: config.model,
          duration: ((Date.now() - start) / 1000).toFixed(1) + 's',
        }));
      } catch (e) {
        log.error('[invoke] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (await gateways.handleHttp(req, res)) return;

    if (tools.handleHttp && await tools.handleHttp(req, res)) return;

    if (req.url === '/health' || req.url === '/') {
      const status = {
        status: 'ok',
        version: '0.3.0',
        uptime: process.uptime(),
        gateways: gateways.listStatuses(),
        graph: graph.db ? 'connected' : 'disconnected',
        sessions: sessions.db ? 'connected' : 'disconnected',
        learner: learner?.db ? 'active' : 'disabled',
        model: config.model,
        timestamp: new Date().toISOString(),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const healthBind = config.healthBindAddr || '127.0.0.1';
  server.listen(config.healthPort, healthBind, () => {
    log.info(`Health check server on ${healthBind}:${config.healthPort}`);
  });

  let retries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && retries < 5) {
      retries++;
      const nextPort = config.healthPort + retries;
      log.warn(`Health port ${config.healthPort + retries - 1} in use, trying ${nextPort}`);
      server.listen(nextPort, '127.0.0.1');
    } else if (e.code === 'EADDRINUSE') {
      log.warn('Could not find free health check port, continuing without health server');
    }
  });

  return server;
}

module.exports = { boot, startHealthServer };

if (require.main === module) {
  boot().catch(e => {
    console.error('Spore Core boot failed:', e);
    process.exit(1);
  });
}
