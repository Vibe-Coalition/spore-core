/**
 * graph/export-import.js — Portable knowledge-graph export + import.
 *
 * EXPORT captures everything the operator has taught the agent: nodes, aspects,
 * attributes, edges, aliases, node_sources, reflections, derived_facts. It
 * EXCLUDES the seed identity layer — reference nodes (`ref-*`), the agent's
 * self node (type=`self`/`agent`), and the shared `spore` system node — since
 * those come from seed-graph.sql and are recreated on every fresh install.
 *
 * For edges that point to excluded nodes (e.g. `alice knows <self-agent>` or
 * `tool-x documents ref-tailscale`), we don't drop them — we emit an
 * `externalSource`/`externalTarget` marker with the original id/label/type so
 * the IMPORT step can rewire the edge to the destination's equivalent node.
 *
 * IMPORT runs in a transaction. On ID collision it skips (safest default —
 * never overwrite existing user data). Edges with externalSource/Target get
 * resolved by id→label→type match against the destination. A report is
 * returned summarising imported/skipped/warnings.
 */

const EXCLUDED_TYPES = new Set(['reference', 'self', 'agent']);
const EXCLUDED_IDS = new Set(['spore']); // the seed system root — shared across deployments

// ─────────────────────────────────────────────────────────────────────
// Portable settings + providers — curated maps of what's safe to carry
// to a different deployment. DO NOT add deployment-specific knobs here
// (ports, paths, agentId, public URL). ENV var names are used for
// `_applyEnvUpdates` on import.
// ─────────────────────────────────────────────────────────────────────

const REDACTED = '***redacted***';

// Config key → env var. Supports dotted keys like 'voice.ttsVoice'.
const PORTABLE_SETTINGS_ENV = {
  displayName: 'SPORE_DISPLAY_NAME',
  casualModel: 'SPORE_CASUAL_MODEL',
  normalModel: 'SPORE_NORMAL_MODEL',
  plannerModel: 'SPORE_PLANNER_MODEL',
  subagentModel: 'SPORE_SUBAGENT_MODEL',
  learnerModel: 'SPORE_LEARNER_MODEL',
  imageVlmModel: 'SPORE_IMAGE_VLM_MODEL',
  videoVlmModel: 'SPORE_VIDEO_VLM_MODEL',
  audioVlmModel: 'SPORE_AUDIO_VLM_MODEL',
  browserBackend: 'SPORE_BROWSER_BACKEND',
  tempNodeTtlHours: 'SPORE_TEMP_NODE_TTL_HOURS',
  learningMode: 'SPORE_LEARNING_MODE',
  heartbeatIntervalMinutes: 'SPORE_HEARTBEAT_MINUTES',
  janitorMode: 'SPORE_JANITOR_MODE',
  janitorIntervalMinutes: 'SPORE_JANITOR_INTERVAL_MINUTES',
  janitorRecycleBinTtlDays: 'SPORE_JANITOR_RECYCLE_BIN_TTL_DAYS',
  janitorPruneBatchSize: 'SPORE_JANITOR_PRUNE_BATCH',
  graphBackupIntervalMinutes: 'SPORE_BACKUP_INTERVAL_MINUTES',
  graphBackupRetention: 'SPORE_BACKUP_RETENTION',
  clusterUsername: 'SPORE_CLUSTER_USERNAME',
  clusterLoginHost: 'SPORE_CLUSTER_LOGIN_HOST',
  clusterDefaultPartition: 'SPORE_CLUSTER_PARTITION',
  clusterTmuxPrefix: 'SPORE_CLUSTER_TMUX_PREFIX',
};

// Plain (non-env) keys that are portable — live-patched into config but not
// persisted as env vars (nicknames is a list; complex knobs are nested objects).
const PORTABLE_SETTINGS_PLAIN = [
  'nicknames',
  'maxTokens',
  'contextWindow',
  'subagentMaxTokens',
  'maxSessionMessages',
  'compactTokenThreshold',
  'sessionIdleTimeoutMinutes',
  'sessionDailyResetHour',
  'maxMessageLength',
  'typingInterval',
  'maxQueuePerChannel',
  'messageDebounceMs',
  'agentTimeoutMs',
  'intermediateTextThrottleSeconds',
  'dmMaxIterations',
  'tokenBudgetPressure',
  'maxSubagentChildren',
  'subagentMaxIter',
  'subagentTimeoutSeconds',
  'lullMaxIterations',
  'openaiReasoningEffort',
  'loopDetection',
  'proactive',
  'voice',
  'privacy',
  'hostReadPaths',
  'extraPaths',
];

// Provider → { valueKey in config: env var }. key/apiKey/authHeader are
// SECRETS and get redacted unless includeSecrets is true.
const PROVIDER_DEFS = {
  anthropic: {
    envMap: { anthropicApiKey: 'ANTHROPIC_API_KEY' },
    secretFields: ['anthropicApiKey'],
  },
  openai: {
    envMap: { openaiApiKey: 'OPENAI_API_KEY', openaiBaseUrl: 'OPENAI_BASE_URL' },
    secretFields: ['openaiApiKey'],
  },
  openrouter: {
    envMap: {
      openrouterApiKey: 'OPENROUTER_API_KEY',
      openrouterBaseUrl: 'OPENROUTER_BASE_URL',
      openrouterReferer: 'OPENROUTER_REFERER',
    },
    secretFields: ['openrouterApiKey'],
  },
  local: {
    envMap: { localModelBaseUrl: 'LOCAL_MODEL_BASE_URL', localModelApiKey: 'LOCAL_MODEL_API_KEY' },
    secretFields: ['localModelApiKey'],
  },
};

function exportProviders(config, { includeSecrets = false } = {}) {
  if (!config) return null;
  const out = {};
  for (const [name, def] of Object.entries(PROVIDER_DEFS)) {
    const block = {};
    for (const [cfgKey] of Object.entries(def.envMap)) {
      const v = config[cfgKey];
      if (v == null || v === '') continue;
      if (def.secretFields.includes(cfgKey) && !includeSecrets) {
        block[cfgKey] = REDACTED;
      } else {
        block[cfgKey] = v;
      }
    }
    if (Object.keys(block).length) out[name] = block;
  }
  // Custom providers (SPORE_PROVIDER_<NAME>_*)
  if (config.customProviders && typeof config.customProviders === 'object') {
    out.custom = {};
    for (const [name, cfg] of Object.entries(config.customProviders)) {
      if (!cfg) continue;
      const block = { name };
      if (cfg.url) block.url = cfg.url;
      if (cfg.authHeader) block.authHeader = cfg.authHeader;
      if (cfg.key) block.key = includeSecrets ? cfg.key : REDACTED;
      out.custom[name] = block;
    }
    if (!Object.keys(out.custom).length) delete out.custom;
  }
  return Object.keys(out).length ? out : null;
}

function exportSettings(config) {
  if (!config) return null;
  const out = {};
  for (const key of Object.keys(PORTABLE_SETTINGS_ENV)) {
    if (config[key] != null && config[key] !== '') out[key] = config[key];
  }
  for (const key of PORTABLE_SETTINGS_PLAIN) {
    if (config[key] != null) out[key] = config[key];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Compute the env updates + live-config patches to apply on import.
 * Values equal to REDACTED are skipped (preserve destination secrets).
 * Returns { envUpdates: {KEY: VAL}, configPatches: {k: v}, applied: [...], skipped: [...] }.
 */
function planProviderImport(providers, currentConfig) {
  const envUpdates = {};
  const configPatches = {};
  const applied = [];
  const skipped = [];
  if (!providers || typeof providers !== 'object') return { envUpdates, configPatches, applied, skipped };

  for (const [name, def] of Object.entries(PROVIDER_DEFS)) {
    const block = providers[name];
    if (!block) continue;
    for (const [cfgKey, envKey] of Object.entries(def.envMap)) {
      const v = block[cfgKey];
      if (v == null || v === '') continue;
      if (v === REDACTED) { skipped.push(`${name}.${cfgKey} (redacted)`); continue; }
      envUpdates[envKey] = String(v);
      configPatches[cfgKey] = v;
      applied.push(`${name}.${cfgKey}`);
    }
  }
  // Custom providers
  const custom = providers.custom || {};
  if (Object.keys(custom).length) {
    configPatches.customProviders = { ...(currentConfig?.customProviders || {}) };
    for (const [name, block] of Object.entries(custom)) {
      if (!block) continue;
      const NAME = String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const cur = configPatches.customProviders[name] || { name };
      if (block.url) {
        envUpdates[`SPORE_PROVIDER_${NAME}_URL`] = String(block.url);
        cur.url = block.url;
      }
      if (block.authHeader) {
        envUpdates[`SPORE_PROVIDER_${NAME}_AUTH_HEADER`] = String(block.authHeader);
        cur.authHeader = block.authHeader;
      }
      if (block.key && block.key !== REDACTED) {
        envUpdates[`SPORE_PROVIDER_${NAME}_KEY`] = String(block.key);
        cur.key = block.key;
      } else if (block.key === REDACTED) {
        skipped.push(`custom.${name}.key (redacted)`);
      }
      configPatches.customProviders[name] = cur;
      applied.push(`custom.${name}`);
    }
  }
  return { envUpdates, configPatches, applied, skipped };
}

function planSettingsImport(settings) {
  const envUpdates = {};
  const configPatches = {};
  const applied = [];
  if (!settings || typeof settings !== 'object') return { envUpdates, configPatches, applied };

  for (const [key, envKey] of Object.entries(PORTABLE_SETTINGS_ENV)) {
    if (!(key in settings)) continue;
    const v = settings[key];
    if (v == null || v === '') continue;
    envUpdates[envKey] = Array.isArray(v) ? v.join(',') : String(v);
    configPatches[key] = v;
    applied.push(key);
  }
  for (const key of PORTABLE_SETTINGS_PLAIN) {
    if (!(key in settings)) continue;
    configPatches[key] = settings[key];
    applied.push(key);
  }
  return { envUpdates, configPatches, applied };
}

function _isExcluded(node, agentId) {
  if (!node) return true;
  if (EXCLUDED_TYPES.has(node.type)) return true;
  if (EXCLUDED_IDS.has(node.id)) return true;
  if (agentId && node.id === agentId) return true;
  return false;
}

function _parseJson(s, fallback = null) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function sanitizeGraphMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return null;
  const allowed = [
    'slug', 'name', 'description', 'role', 'protected', 'managed', 'activationLocked',
    'seedProfile', 'identityKey', 'platform', 'externalUserId', 'externalChannelId',
    'source', 'createdBy', 'created', 'owner', 'collaborators', 'allowedUsers',
    'allowedWebUsers', 'projectKey', 'projectRoot', 'projectRemote',
  ];
  const out = {};
  for (const key of allowed) {
    if (meta[key] !== undefined && meta[key] !== null) out[key] = meta[key];
  }
  return Object.keys(out).length ? out : null;
}

function exportGraph(db, { agentId = null, graphMeta = null } = {}) {
  if (!db) throw new Error('no db');

  const allNodes = db.prepare('SELECT * FROM nodes').all();
  const excludedSet = new Set(
    allNodes.filter(n => _isExcluded(n, agentId)).map(n => n.id)
  );
  const excludedInfo = new Map(
    allNodes.filter(n => _isExcluded(n, agentId)).map(n => [n.id, { id: n.id, label: n.label, type: n.type }])
  );
  const keptNodes = allNodes.filter(n => !excludedSet.has(n.id));

  const aspectsByNode = {};
  for (const a of db.prepare('SELECT * FROM aspects').all()) {
    (aspectsByNode[a.node_id] ||= []).push(a);
  }
  const attrsByAspect = {};
  for (const at of db.prepare('SELECT * FROM attributes').all()) {
    (attrsByAspect[at.aspect_id] ||= []).push(at);
  }
  const aliasesByNode = {};
  for (const al of db.prepare('SELECT * FROM aliases').all()) {
    (aliasesByNode[al.node_id] ||= []).push(al.alias);
  }
  const sourcesByNode = {};
  try {
    for (const ns of db.prepare('SELECT * FROM node_sources').all()) {
      (sourcesByNode[ns.node_id] ||= []).push(ns.source);
    }
  } catch (e) { console.warn('[export-import] db.prepare failed: ' + e.message); }

  const nodes = keptNodes.map(n => ({
    id: n.id,
    label: n.label,
    type: n.type,
    description: n.description || null,
    importance: n.importance ?? 5,
    mentions: n.mentions ?? 1,
    session_count: n.session_count ?? 0,
    provenance: n.provenance || null,
    extracted_with: n.extracted_with || null,
    extracted_at: n.extracted_at || null,
    created: n.created || null,
    updated: n.updated || null,
    extra: _parseJson(n.extra, {}),
    aliases: aliasesByNode[n.id] || [],
    sources: sourcesByNode[n.id] || [],
    aspects: (aspectsByNode[n.id] || []).map(a => ({
      name: a.name,
      weight: a.weight ?? 5,
      extracted_with: a.extracted_with || null,
      attributes: (attrsByAspect[a.id] || []).map(x => ({
        content: x.content,
        importance: x.importance ?? 5,
        source: x.source || null,
        created: x.created || null,
        updated_at: x.updated_at || null,
        extracted_with: x.extracted_with || null,
        event_date: x.event_date || null,
        document_date: x.document_date || null,
        source_excerpt: x.source_excerpt || null,
      })),
    })),
  }));

  // Edges: rewrite endpoints that point at excluded nodes into externalSource/
  // externalTarget markers so the destination can re-resolve them. Drop edges
  // where both endpoints are excluded (seed-only connections).
  const rawEdges = db.prepare('SELECT * FROM edges').all();
  const edges = [];
  let edgesDroppedBothExcluded = 0;
  for (const e of rawEdges) {
    const srcExcluded = excludedSet.has(e.source);
    const tgtExcluded = excludedSet.has(e.target);
    if (srcExcluded && tgtExcluded) { edgesDroppedBothExcluded++; continue; }
    const entry = { type: e.type, weight: e.weight ?? 1.0, created: e.created || null, extracted_with: e.extracted_with || null };
    if (srcExcluded) {
      entry.externalSource = excludedInfo.get(e.source);
    } else {
      entry.source = e.source;
    }
    if (tgtExcluded) {
      entry.externalTarget = excludedInfo.get(e.target);
    } else {
      entry.target = e.target;
    }
    edges.push(entry);
  }

  // Reflections — keep only those attached to exported nodes (reflections on
  // the agent self-node or on ref-* aren't useful in a new deployment).
  let reflections = [];
  try {
    reflections = db.prepare('SELECT * FROM reflections').all()
      .filter(r => !excludedSet.has(r.node_id))
      .map(r => ({ nodeId: r.node_id, content: r.content, model: r.model || null, source: r.source || null, created: r.created || null }));
  } catch (e) { console.warn('[export-import] db.prepare failed: ' + e.message); }

  // Derived facts — keep those whose source node ids are all still exported.
  let derivedFacts = [];
  try {
    derivedFacts = db.prepare('SELECT * FROM derived_facts WHERE invalidated_at IS NULL').all()
      .map(d => ({
        content: d.content,
        source_node_ids: _parseJson(d.source_node_ids, []),
        confidence: d.confidence || 'medium',
        reasoning_type: d.reasoning_type || 'derived',
        premises: _parseJson(d.premises, null),
        created: d.created || null,
      }))
      .filter(d => (d.source_node_ids || []).every(id => !excludedSet.has(id)));
  } catch (e) { console.warn('[export-import] db.prepare failed: ' + e.message); }

  const stats = {
    totalNodes: allNodes.length,
    exportedNodes: nodes.length,
    excludedNodes: excludedSet.size,
    exportedEdges: edges.length,
    droppedEdges: edgesDroppedBothExcluded,
    reflections: reflections.length,
    derivedFacts: derivedFacts.length,
  };

  return {
    version: 1,
    format: 'spore-graph-export',
    exportedAt: new Date().toISOString(),
    sourceAgent: agentId ? { id: agentId } : null,
    graph: sanitizeGraphMeta(graphMeta),
    stats,
    nodes,
    edges,
    reflections,
    derivedFacts,
  };
}

function _resolveExternalEndpoint(db, ext, cache = new Map()) {
  if (!ext || !ext.id) return null;
  if (cache.has(ext.id)) return cache.get(ext.id);
  // 1. Exact id match (works for stable ref-* ids shared across deployments)
  let row = db.prepare('SELECT id FROM nodes WHERE id = ?').get(ext.id);
  if (row) { cache.set(ext.id, row.id); return row.id; }
  // 2. Label match within the same type (finds self-node across deployments)
  if (ext.label && ext.type) {
    row = db.prepare('SELECT id FROM nodes WHERE type = ? AND label = ? LIMIT 1').get(ext.type, ext.label);
    if (row) { cache.set(ext.id, row.id); return row.id; }
  }
  // 3. For self/agent: match whatever the destination's primary self-node is
  if (ext.type === 'self' || ext.type === 'agent') {
    row = db.prepare("SELECT id FROM nodes WHERE type IN ('self','agent') ORDER BY importance DESC LIMIT 1").get();
    if (row) { cache.set(ext.id, row.id); return row.id; }
  }
  cache.set(ext.id, null);
  return null;
}

function importGraph(db, payload, { log = console } = {}) {
  if (!db) throw new Error('no db');
  if (!payload || payload.format !== 'spore-graph-export') {
    throw new Error('not a spore-graph-export payload');
  }

  const report = {
    nodesImported: 0, nodesSkipped: [], aspectsImported: 0, attributesImported: 0,
    edgesImported: 0, edgesSkipped: [], aliasesImported: 0, nodeSourcesImported: 0,
    reflectionsImported: 0, derivedFactsImported: 0,
    warnings: [],
  };

  const insNode = db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, mentions, session_count, provenance, extracted_with, extracted_at, created, updated, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insAspect = db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)');
  const insAttr = db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, created, updated_at, extracted_with, event_date, document_date, source_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insEdge = db.prepare('INSERT INTO edges (source, target, type, weight, created, extracted_with, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insAlias = db.prepare('INSERT INTO aliases (node_id, alias) VALUES (?, ?)');
  const insNodeSource = db.prepare('INSERT INTO node_sources (node_id, source) VALUES (?, ?)');
  const insReflection = db.prepare('INSERT INTO reflections (node_id, content, model, source, created) VALUES (?, ?, ?, ?, ?)');
  const insDerivedFact = db.prepare(`
    INSERT INTO derived_facts (content, source_node_ids, confidence, reasoning_type, premises, created)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const nodeExists = db.prepare('SELECT 1 FROM nodes WHERE id = ?');

  const importedIds = new Set();
  const prevFk = db.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 0;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Nodes + aspects + attributes + aliases + sources
    for (const n of (payload.nodes || [])) {
      if (!n?.id) continue;
      if (nodeExists.get(n.id)) {
        report.nodesSkipped.push(n.id);
        continue;
      }
      insNode.run(
        n.id, n.label || n.id, n.type || 'concept', n.description || null,
        n.importance ?? 5, n.mentions ?? 1, n.session_count ?? 0,
        n.provenance || 'imported', n.extracted_with || 'import', n.extracted_at || null,
        n.created || new Date().toISOString(), new Date().toISOString(),
        JSON.stringify(n.extra || {})
      );
      importedIds.add(n.id);
      report.nodesImported++;

      for (const a of (n.aspects || [])) {
        const aspectResult = insAspect.run(n.id, a.name, a.weight ?? 5, a.extracted_with || 'import');
        report.aspectsImported++;
        for (const at of (a.attributes || [])) {
          insAttr.run(
            aspectResult.lastInsertRowid, at.content, at.importance ?? 5,
            at.source || 'imported', at.created || new Date().toISOString(),
            at.updated_at || new Date().toISOString(), at.extracted_with || 'import',
            at.event_date || null, at.document_date || null, at.source_excerpt || null
          );
          report.attributesImported++;
        }
      }

      for (const alias of (n.aliases || [])) {
        try { insAlias.run(n.id, alias); report.aliasesImported++; } catch (e) { console.warn('[export-import] insAlias.run failed: ' + e.message); }
      }
      for (const src of (n.sources || [])) {
        try { insNodeSource.run(n.id, src); report.nodeSourcesImported++; } catch (e) { console.warn('[export-import] insNodeSource.run failed: ' + e.message); }
      }
    }

    // 2. Edges — resolve external endpoints against the destination's nodes
    const extCache = new Map();
    for (const e of (payload.edges || [])) {
      let source = e.source;
      let target = e.target;
      if (!source && e.externalSource) source = _resolveExternalEndpoint(db, e.externalSource, extCache);
      if (!target && e.externalTarget) target = _resolveExternalEndpoint(db, e.externalTarget, extCache);
      if (!source || !target) {
        report.edgesSkipped.push({
          type: e.type,
          reason: !source ? `externalSource ${e.externalSource?.id || '?'} not resolvable` : `externalTarget ${e.externalTarget?.id || '?'} not resolvable`,
        });
        continue;
      }
      // Require both endpoints to exist in the destination now (either freshly
      // imported or already present or resolved from external).
      if (!nodeExists.get(source) || !nodeExists.get(target)) {
        report.edgesSkipped.push({ type: e.type, source, target, reason: 'endpoint not in destination' });
        continue;
      }
      try {
        insEdge.run(source, target, e.type || 'related_to', e.weight ?? 1.0, e.created || new Date().toISOString(), e.extracted_with || 'import', e.confidence || null);
        report.edgesImported++;
      } catch (err) {
        report.edgesSkipped.push({ type: e.type, source, target, reason: err.message });
      }
    }

    // 3. Reflections — only for nodes that landed
    for (const r of (payload.reflections || [])) {
      if (!r?.nodeId || !nodeExists.get(r.nodeId)) continue;
      try {
        insReflection.run(r.nodeId, r.content, r.model || null, r.source || 'imported', r.created || new Date().toISOString());
        report.reflectionsImported++;
      } catch (e) { console.warn('[export-import] insReflection.run failed: ' + e.message); }
    }

    // 4. Derived facts — only ones where all source nodes exist post-import
    for (const d of (payload.derivedFacts || [])) {
      const srcIds = Array.isArray(d.source_node_ids) ? d.source_node_ids : [];
      if (!srcIds.length || !srcIds.every(id => nodeExists.get(id))) continue;
      try {
        insDerivedFact.run(
          d.content, JSON.stringify(srcIds), d.confidence || 'medium',
          d.reasoning_type || 'derived', d.premises ? JSON.stringify(d.premises) : null,
          d.created || new Date().toISOString()
        );
        report.derivedFactsImported++;
      } catch (e) { console.warn('[export-import] insDerivedFact.run failed: ' + e.message); }
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    try { db.exec(`PRAGMA foreign_keys = ${prevFk ? 'ON' : 'OFF'}`); } catch (e) { console.warn('[export-import] db.exec failed: ' + e.message); }
  }

  return report;
}

module.exports = {
  exportGraph,
  importGraph,
  exportProviders,
  exportSettings,
  planProviderImport,
  planSettingsImport,
  sanitizeGraphMeta,
  REDACTED,
};
