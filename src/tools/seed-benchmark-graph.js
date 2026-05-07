#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { GraphRegistry } = require('../graph/multi');

const DEFAULT_SLUG = 'benchmark-10k-random';
const DEFAULT_NODES = 10000;
const DEFAULT_EDGES = 30000;
const DEFAULT_SEED = 260506;

function parseArgs(argv) {
  const out = {
    slug: DEFAULT_SLUG,
    nodes: DEFAULT_NODES,
    edges: DEFAULT_EDGES,
    seed: DEFAULT_SEED,
    delete: false,
    dataDir: process.env.SPORE_DATA_DIR || process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.resolve(__dirname, '..', 'data')),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--delete') out.delete = true;
    else if (arg === '--slug') out.slug = String(argv[++i] || out.slug);
    else if (arg === '--nodes') out.nodes = Number(argv[++i] || out.nodes);
    else if (arg === '--edges') out.edges = Number(argv[++i] || out.edges);
    else if (arg === '--seed') out.seed = Number(argv[++i] || out.seed);
    else if (arg === '--data-dir') out.dataDir = path.resolve(String(argv[++i] || out.dataDir));
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run graph:seed-benchmark -- [options]',
        '',
        'Options:',
        '  --nodes N       Total nodes to create, including benchmark self/ref nodes (default 10000)',
        '  --edges N       Random edges to create (default 30000)',
        '  --seed N        Deterministic random seed (default 260506)',
        '  --slug SLUG     Graph slug (default benchmark-10k-random)',
        '  --data-dir DIR  Spore data directory (default /data when present)',
        '  --delete        Delete the benchmark graph instead of creating it',
      ].join('\n'));
      process.exit(0);
    }
  }
  out.nodes = Math.max(10, Math.floor(out.nodes || DEFAULT_NODES));
  out.edges = Math.max(0, Math.floor(out.edges || DEFAULT_EDGES));
  out.seed = Math.floor(out.seed || DEFAULT_SEED);
  return out;
}

function makeLog() {
  const fn = (...args) => console.error(...args);
  return { info: fn, warn: fn, error: fn };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function deleteIfPresent(registry, slug) {
  if (!registry.get(slug)) return false;
  if (registry.getActiveSlug?.() === slug) {
    throw new Error(`Cannot delete active benchmark graph "${slug}". Switch away from it first.`);
  }
  registry.delete(slug);
  return true;
}

function compactCount(n) {
  if (n >= 1000000 && n % 1000000 === 0) return `${n / 1000000}m`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

function clearGraphDb(db) {
  const tables = [
    'edge_sources', 'edges', 'aliases', 'attributes', 'aspects', 'attribute_history',
    'node_sources', 'quality_audits', 'gaps', 'reflections', 'derived_facts',
    'hyperedge_members', 'hyperedges', 'node_group_members', 'node_groups',
    'graph_overviews', 'episodes', 'learner_processed', 'recycle_bin', 'nodes',
  ];
  db.exec('PRAGMA foreign_keys=OFF');
  for (const table of tables) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
  db.exec('PRAGMA foreign_keys=ON');
}

function seedBenchmarkDb(db, opts) {
  const rand = lcg(opts.seed);
  const types = ['person', 'topic', 'project', 'tool', 'memory', 'event', 'organization', 'preference', 'rule', 'artifact'];
  const edgeTypes = ['relates_to', 'uses', 'mentions', 'depends_on', 'informs', 'blocks', 'belongs_to', 'references'];
  const nodeIds = ['benchmark-self', 'ref-benchmark-scope'];
  for (let i = 0; i < opts.nodes - 2; i++) nodeIds.push(`bench-node-${String(i + 1).padStart(5, '0')}`);

  const insertNode = db.prepare(
    `INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAlias = db.prepare('INSERT INTO aliases (node_id, alias) VALUES (?, ?)');
  const insertAspect = db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)');
  const insertAttr = db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, ?, ?)');
  const insertEdge = db.prepare('INSERT INTO edges (source, target, type, weight, extracted_with, confidence) VALUES (?, ?, ?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    insertNode.run(
      'benchmark-self',
      'Benchmark Spore',
      'self',
      'Synthetic root node for graph rendering benchmarks.',
      10,
      100,
      'benchmark',
      'benchmark-seed',
      JSON.stringify({ benchmark: true, role: 'root' }),
    );
    insertNode.run(
      'ref-benchmark-scope',
      'Benchmark Scope',
      'reference',
      'Synthetic reference node explaining that this graph is disposable benchmark data.',
      9,
      80,
      'benchmark',
      'benchmark-seed',
      JSON.stringify({ benchmark: true, role: 'reference' }),
    );
    insertAspect.run('ref-benchmark-scope', 'scope', 9, 'benchmark-seed');
    const scopeAspect = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    insertAttr.run(scopeAspect, 'This graph is generated data for UI/API performance testing and should not be distilled as real knowledge.', 9, 'benchmark-seed', 'benchmark-seed');

    for (let i = 2; i < nodeIds.length; i++) {
      const id = nodeIds[i];
      const type = pick(rand, types);
      const importance = 1 + Math.floor(rand() * 10);
      const mentions = Math.floor(rand() * 250);
      insertNode.run(
        id,
        `Benchmark ${type} ${i - 1}`,
        type,
        `Synthetic ${type} node ${i - 1} generated for benchmark seed ${opts.seed}.`,
        importance,
        mentions,
        'benchmark',
        'benchmark-seed',
        JSON.stringify({
          benchmark: true,
          cluster: Math.floor(rand() * 64),
          score: Math.round(rand() * 1000) / 1000,
        }),
      );
      if (i % 20 === 0) insertAlias.run(id, `bench alias ${i - 1}`);
      if (i % 5 === 0) {
        insertAspect.run(id, 'summary', 3 + Math.floor(rand() * 7), 'benchmark-seed');
        const aspectId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        insertAttr.run(aspectId, `Synthetic fact for ${id}`, 1 + Math.floor(rand() * 10), 'benchmark-seed', 'benchmark-seed');
        insertAttr.run(aspectId, `Benchmark cluster ${Math.floor(rand() * 64)}`, 1 + Math.floor(rand() * 10), 'benchmark-seed', 'benchmark-seed');
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  const edgeKeys = new Set();
  db.exec('BEGIN');
  try {
    insertEdge.run('benchmark-self', 'ref-benchmark-scope', 'documents', 1, 'benchmark-seed', 'high');
    edgeKeys.add('benchmark-self\x00ref-benchmark-scope\x00documents');
    let guard = 0;
    while (edgeKeys.size < opts.edges && guard < opts.edges * 20) {
      guard++;
      const source = pick(rand, nodeIds);
      const target = pick(rand, nodeIds);
      if (source === target) continue;
      const type = pick(rand, edgeTypes);
      const key = `${source}\x00${target}\x00${type}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      const weight = Math.round((0.2 + rand() * 1.8) * 100) / 100;
      insertEdge.run(source, target, type, weight, 'benchmark-seed', rand() > 0.12 ? 'synthetic' : 'low');
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { nodes: nodeIds.length, edges: edgeKeys.size };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const registry = new GraphRegistry(opts.dataDir, { agentId: 'spore', displayName: 'Spore Core' }, makeLog());
  registry.init();

  if (opts.delete) {
    const deleted = deleteIfPresent(registry, opts.slug);
    console.log(JSON.stringify({ ok: true, deleted, slug: opts.slug, dataDir: opts.dataDir }, null, 2));
    return;
  }

  deleteIfPresent(registry, opts.slug);
  const graphName = `Benchmark ${compactCount(opts.nodes)} Random`;
  const slug = registry.create(graphName, `Deterministic random benchmark graph, seed ${opts.seed}`, {
    slug: opts.slug,
    role: 'benchmark',
    protected: false,
    managed: true,
    activationLocked: true,
    seedProfile: 'benchmark',
    source: 'benchmark',
    createdBy: 'benchmark-generator',
    identityKey: `benchmark:random:${opts.seed}:${opts.nodes}:${opts.edges}`,
  });

  const dbPath = registry.getDbPath(slug);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000');
    clearGraphDb(db);
    const counts = seedBenchmarkDb(db, opts);
    const graph = registry.get(slug);
    Object.assign(graph, {
      benchmark: true,
      benchmarkSeed: opts.seed,
      benchmarkRequestedNodes: opts.nodes,
      benchmarkRequestedEdges: opts.edges,
      benchmarkGeneratedAt: new Date().toISOString(),
    });
    registry.refreshStats(slug);
    console.log(JSON.stringify({ ok: true, slug, dataDir: opts.dataDir, dbPath, ...counts }, null, 2));
  } finally {
    try { db.close(); } catch {}
  }
}

try {
  main();
} catch (e) {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
}
