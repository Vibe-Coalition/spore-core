/**
 * feed.js — Cross-session awareness feed (Graph-native)
 *
 * Stores activity entries and per-response token usage in the graph DB.
 * API: readForContext(), write(), log(), logTokens(), readTokenSummary()
 *
 * Actual schema:
 *   nodes      — id TEXT PK, label, type, description, ...
 *   aspects    — id INTEGER PK AUTOINCREMENT, node_id FK→nodes.id, name, weight
 *   attributes — id INTEGER PK AUTOINCREMENT, aspect_id FK→aspects.id, content, importance, source, created
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function graphDbPath() {
  return process.env.GRAPH_DB_PATH || path.join(__dirname, 'data', 'graph.db');
}
const ACTIVITY_NODE_ID = 'anima-activity-log';
const TOKEN_NODE_ID = 'anima-token-log';
const MAX_ENTRIES = 200;
const MAX_TOKEN_DAYS = 90;     // Keep 90 daily rollups (~3 months)
const CONTEXT_LINES = 30;

// Rough cost estimates (USD per million tokens) — update if pricing changes
const COST_PER_M_INPUT = 3.00;
const COST_PER_M_OUTPUT = 15.00;

let _db = null;

function getDb() {
  if (!_db) {
    try {
      _db = new DatabaseSync(graphDbPath());
      _db.exec('PRAGMA journal_mode=WAL');
      _db.exec('PRAGMA busy_timeout=5000');
    } catch (e) {
      _db = null;
    }
  }
  return _db;
}

/**
 * Ensure a log node and named aspect exist. Returns aspect id or null.
 */
function ensureAspect(db, nodeId, nodeLabel, aspectName) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO nodes (id, label, type, description)
      VALUES (?, ?, ?, ?)
    `).run(nodeId, nodeLabel, 'log', `Graph-native log node: ${nodeLabel}`);

    db.prepare(`
      INSERT OR IGNORE INTO aspects (node_id, name, weight)
      VALUES (?, ?, 5)
    `).run(nodeId, aspectName);

    const aspect = db.prepare(
      'SELECT id FROM aspects WHERE node_id = ? AND name = ?'
    ).get(nodeId, aspectName);

    return aspect ? aspect.id : null;
  } catch (e) {
    console.error('[feed] ensureAspect failed:', e.message);
    return null;
  }
}

function appendEntry(nodeId, nodeLabel, aspectName, content, maxEntries) {
  try {
    const db = getDb();
    if (!db) return;
    const aspectId = ensureAspect(db, nodeId, nodeLabel, aspectName);
    if (!aspectId) return;

    db.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source)
      VALUES (?, ?, 5, 'feed.js')
    `).run(aspectId, content);

    // Prune oldest beyond max
    db.prepare(`
      DELETE FROM attributes WHERE id IN (
        SELECT id FROM attributes WHERE aspect_id = ?
        ORDER BY id DESC LIMIT -1 OFFSET ?
      )
    `).run(aspectId, maxEntries);
  } catch (e) {
    console.error('[feed] appendEntry failed:', e.message);
  }
}

function readEntries(nodeId, aspectName, maxLines) {
  try {
    const db = getDb();
    if (!db) return [];
    const rows = db.prepare(`
      SELECT a.content FROM attributes a
      JOIN aspects asp ON a.aspect_id = asp.id
      WHERE asp.node_id = ? AND asp.name = ?
      ORDER BY a.id DESC LIMIT ?
    `).all(nodeId, aspectName, maxLines);
    return rows.map(r => r.content).reverse();
  } catch (e) {
    return [];
  }
}

// ── Activity feed ──────────────────────────────────────────────────────────────

function write(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  appendEntry(ACTIVITY_NODE_ID, 'Anima Activity Log', 'entries', entry, MAX_ENTRIES);
}

function log({ channelName, userName, userMessage, myResponse, trigger, usage, iterations }) {
  const ts = new Date().toISOString();
  const userSnip = (userMessage || '').slice(0, 100).replace(/\n/g, ' ');
  const respSnip = (myResponse || '').slice(0, 100).replace(/\n/g, ' ');
  const entry = `[${ts}] #${channelName || 'dm'} | ${userName}: "${userSnip}" → Agent: "${respSnip}"`;

  appendEntry(ACTIVITY_NODE_ID, 'Anima Activity Log', 'entries', entry, MAX_ENTRIES);

  if (usage) {
    logTokens({ channelName, trigger, usage, iterations });
  }
}

// ── Token tracking ─────────────────────────────────────────────────────────────

function _derivePlatform(channel) {
  if (!channel) return 'unknown';
  if (channel.startsWith('telegram:')) return 'telegram';
  if (channel.startsWith('discord:')) return 'discord';
  if (channel === 'dm') return 'dm';
  return 'other';
}

function _incDim(map, key, input, output, iters) {
  const e = map[key] || { in: 0, out: 0, calls: 0, iters: 0 };
  e.in    += input;
  e.out   += output;
  e.calls += 1;
  e.iters += iters;
  map[key] = e;
}

/**
 * Log a token usage event. Aggregates into a daily rollup per day.
 * One attribute row per day (source = YYYY-MM-DD), updated in-place.
 * Keeps MAX_TOKEN_DAYS days of history.
 *
 * Dimensions per day:
 *   totals: input, output, calls, iters
 *   byChannel:  { "telegram:Kyle": { in, out, calls, iters }, ... }
 *   byTrigger:  { "mention": ..., "lull": ..., "dm": ..., "voice": ... }
 *   byPlatform: { "telegram": ..., "discord": ... }
 */
function logTokens({ channelName, trigger, usage, iterations }) {
  if (!usage) return;
  const newIn    = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  const newOut   = usage.output_tokens || 0;
  const newCacheRead = usage.cache_read_input_tokens || 0;
  const newIters = iterations || 1;
  const channel  = channelName || 'dm';
  const trig     = trigger || 'unknown';
  const platform = _derivePlatform(channel);
  const today    = new Date().toISOString().slice(0, 10);

  try {
    const db = getDb();
    if (!db) return;
    const aspectId = ensureAspect(db, TOKEN_NODE_ID, 'Anima Token Log', 'daily');
    if (!aspectId) return;

    const existing = db.prepare(
      'SELECT id, content FROM attributes WHERE aspect_id = ? AND source = ?'
    ).get(aspectId, today);

    let day;
    if (existing) {
      try { day = JSON.parse(existing.content); } catch { day = null; }
    }
    if (!day || !day.date) {
      day = { date: today, input: 0, output: 0, cached: 0, calls: 0, iters: 0, byChannel: {}, byTrigger: {}, byPlatform: {} };
    }
    // Normalise old entries (had `input`/`output` at top level and in sub-maps)
    day.input  = day.input  || 0;
    day.output = day.output || 0;
    day.cached = day.cached || 0;
    day.calls  = day.calls  || 0;
    day.iters  = day.iters  || 0;
    // Normalise any old byChannel entries that used `input`/`output` keys
    for (const k of Object.keys(day.byChannel || {})) {
      const c = day.byChannel[k];
      if (c.input != null && c.in == null) { c.in = c.input; c.out = c.output || 0; delete c.input; delete c.output; }
    }

    day.input  += newIn;
    day.output += newOut;
    day.cached += newCacheRead;
    day.calls  += 1;
    day.iters  += newIters;
    day.byChannel  = day.byChannel  || {};
    day.byTrigger  = day.byTrigger  || {};
    day.byPlatform = day.byPlatform || {};

    _incDim(day.byChannel,  channel,  newIn, newOut, newIters);
    _incDim(day.byTrigger,  trig,     newIn, newOut, newIters);
    _incDim(day.byPlatform, platform, newIn, newOut, newIters);

    if (existing) {
      db.prepare('UPDATE attributes SET content = ? WHERE id = ?').run(JSON.stringify(day), existing.id);
    } else {
      db.prepare(
        'INSERT INTO attributes (aspect_id, content, importance, source) VALUES (?, ?, 5, ?)'
      ).run(aspectId, JSON.stringify(day), today);
      // Prune to MAX_TOKEN_DAYS (keep most recent by date)
      db.prepare(`
        DELETE FROM attributes WHERE id IN (
          SELECT id FROM attributes WHERE aspect_id = ?
          ORDER BY source DESC LIMIT -1 OFFSET ?
        )
      `).run(aspectId, MAX_TOKEN_DAYS);
    }
  } catch (e) {
    console.error('[feed] logTokens failed:', e.message);
  }
}

function _addCost(stats) {
  const inputCost  = (stats.input  / 1_000_000) * COST_PER_M_INPUT;
  const outputCost = (stats.output / 1_000_000) * COST_PER_M_OUTPUT;
  return { ...stats, inputCost: inputCost.toFixed(4), outputCost: outputCost.toFixed(4), totalCost: (inputCost + outputCost).toFixed(4) };
}

/**
 * Read and summarize token usage from daily rollups.
 * Returns totals, time windows, and three breakdowns: byChannel, byTrigger, byPlatform.
 */
function readTokenSummary() {
  try {
    const db = getDb();
    if (!db) return null;
    const aspectId = ensureAspect(db, TOKEN_NODE_ID, 'Anima Token Log', 'daily');
    if (!aspectId) return null;

    const rows = db.prepare(
      'SELECT content, source FROM attributes WHERE aspect_id = ? ORDER BY source DESC LIMIT ?'
    ).all(aspectId, MAX_TOKEN_DAYS);

    const dailyMap = {};
    for (const row of rows) {
      let entry;
      try { entry = JSON.parse(row.content); } catch { continue; }
      if (!entry.date) continue;
      dailyMap[entry.date] = entry;
    }

    const daily = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));

    // Merge a dimension map (byChannel / byTrigger / byPlatform) into an accumulator
    // Handles both old schema (input/output) and new schema (in/out)
    function mergeDim(acc, dimMap) {
      for (const [key, s] of Object.entries(dimMap || {})) {
        const e = acc[key] || { in: 0, out: 0, calls: 0, iters: 0 };
        e.in    += (s.in    != null ? s.in    : s.input  || 0);
        e.out   += (s.out   != null ? s.out   : s.output || 0);
        e.calls += s.calls || 0;
        e.iters += s.iters || 0;
        acc[key] = e;
      }
    }

    function sumDays(n) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - n);
      const c = cutoff.toISOString().slice(0, 10);
      const subset = daily.filter(d => d.date >= c);
      const totals = subset.reduce(
        (acc, d) => ({ input: acc.input + (d.input||0), output: acc.output + (d.output||0), calls: acc.calls + (d.calls||0), iters: acc.iters + (d.iters||0) }),
        { input: 0, output: 0, calls: 0, iters: 0 }
      );
      const byChannel = {}, byTrigger = {}, byPlatform = {};
      for (const d of subset) {
        mergeDim(byChannel,  d.byChannel);
        mergeDim(byTrigger,  d.byTrigger);
        mergeDim(byPlatform, d.byPlatform);
      }
      return { ...totals, byChannel, byTrigger, byPlatform };
    }

    const todayStr     = new Date().toISOString().slice(0, 10);
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const todayData    = dailyMap[todayStr]     || { input: 0, output: 0, calls: 0, iters: 0 };
    const yestData     = dailyMap[yesterdayStr] || { input: 0, output: 0, calls: 0, iters: 0 };
    const allTime      = sumDays(99999);

    return {
      today:     _addCost({ date: todayStr,     ...todayData }),
      yesterday: _addCost({ date: yesterdayStr, ...yestData }),
      windows: {
        '7d':    _addCost(sumDays(7)),
        '30d':   _addCost(sumDays(30)),
        allTime: _addCost(allTime),
      },
      // All-time dimension breakdowns (most useful for the overview)
      byChannel:  allTime.byChannel,
      byTrigger:  allTime.byTrigger,
      byPlatform: allTime.byPlatform,
      daily: daily.slice(0, 30).map(d => _addCost({
        date: d.date, input: d.input||0, output: d.output||0, calls: d.calls||0, iters: d.iters||0,
      })),
      costRates: { inputPerM: COST_PER_M_INPUT, outputPerM: COST_PER_M_OUTPUT },
    };
  } catch (e) {
    console.error('[feed] readTokenSummary failed:', e.message);
    return null;
  }
}

// ── Context injection ──────────────────────────────────────────────────────────

function readForContext({ channelId, guildId, userId, maxLines = 50 } = {}) {
  try {
    const activityLines = readEntries(ACTIVITY_NODE_ID, 'entries', CONTEXT_LINES);

    if (activityLines.length === 0) return null;
    return '## Recent Activity (other conversations — NOT the current one)\nThese are snippets from your other sessions. Do NOT assume these people or topics are part of the current conversation.\n```\n' + activityLines.join('\n') + '\n```';
  } catch (e) {
    return null;
  }
}

function _closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

module.exports = { readForContext, write, log, logTokens, readTokenSummary, _closeDb };
