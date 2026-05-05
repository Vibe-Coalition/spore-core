/**
 * channel-distiller.js
 *
 * Periodically promotes reusable, non-private lessons from per-person
 * channel graphs into the protected general knowledge base. Channel graphs
 * are long lived, so they cannot rely on a session-end distillation hook.
 */

const graphEvents = require('../graph/events');
const { modelForTier } = require('../settings');

const SOURCE = 'channel-distill';
const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_IDLE_MINUTES = 45;
const DEFAULT_BATCH_SIZE = 3;

const ALLOWED_TYPES = new Set(['tool', 'library', 'framework', 'service', 'concept', 'system']);

function _minutes(configValue, fallback) {
  const n = Number(configValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _parseJSON(text) {
  if (!text || !String(text).trim()) return null;
  let cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (cleaned[0] !== '{' && cleaned[0] !== '[') {
    const match = cleaned.match(/[\{\[][\s\S]*[\}\]]/);
    if (match) cleaned = match[0];
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function _sanitizeLesson(text) {
  const raw = String(text || '').replace(/^Learned in channel:\s*/i, '').trim();
  if (!raw || raw.length < 20) return null;
  if (/(sk-[a-z0-9]|ghp_[a-z0-9]|password\s*=|api[_-]?key\s*=|secret\s*=)/i.test(raw)) return null;
  if (_looksChannelPrivate(raw)) return null;
  return raw
    .replace(/\s*\(source:\s*[^)]+\)\s*$/i, '')
    .replace(/\/(?:home|Users|mnt|app|workspace|data)\/[^\s`'")]+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s`'")]+/g, '<path>')
    .replace(/\b-?\d{6,}\b/g, '<id>')
    .slice(0, 600);
}

function _looksChannelPrivate(text) {
  const raw = String(text || '');
  const s = raw.toLowerCase();
  if (!s) return true;
  if (/@[a-z0-9_]{3,}/i.test(raw)) return true;
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(raw)) return true;
  if (/\b(?:user|chat|channel|telegram|slack|discord)[ _-]?id\b/i.test(raw)) return true;
  if (/\b(?:pairing code|approved user|dm policy|private dm)\b/i.test(s)) return true;
  if (/\b(?:remind|reminder|schedule|cron job|daily report|weekly report|notification preference|timezone|wake me|send me|send him|send her)\b/i.test(s)) return true;
  if (/\b(?:this user|that user|for this person|for him|for her|my report|my preference|my schedule)\b/i.test(s)) return true;
  if (/\b-?\d{8,}\b/.test(raw)) return true;
  return false;
}

function _nodeId(value) {
  return String(value || 'lesson')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function _aspectWithAttr(db, nodeId, aspectName, content, source = SOURCE) {
  if (!content) return false;
  let asp = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, aspectName);
  if (!asp) {
    db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 7, ?)').run(nodeId, aspectName, source);
    asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  const dup = db.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, content);
  if (dup) return false;
  db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 7, ?, ?)')
    .run(asp.id, content, source, source);
  return true;
}

class ChannelDistiller {
  constructor(config, log, llmClient, learner, registry) {
    this.config = config || {};
    this.log = log || console;
    this.client = llmClient;
    this.learner = learner;
    this.registry = registry;
    this._running = false;
    this._lastRunAt = null;
    this.stats = {
      cycles: 0,
      graphsChecked: 0,
      graphsDistilled: 0,
      promoted: 0,
      errors: 0,
      lastRunAt: null,
    };
  }

  getStats() {
    return { ...this.stats, running: this._running };
  }

  async run({ force = false } = {}) {
    if (this._running) return null;
    if (this.config.channelDistillerEnabled === false) return null;
    if (!this.registry || !this.learner || !this.client) return null;

    const intervalMs = _minutes(this.config.channelDistillerIntervalMinutes, DEFAULT_INTERVAL_MINUTES) * 60_000;
    if (!force && this._lastRunAt && Date.now() - this._lastRunAt < intervalMs) return null;

    this._running = true;
    this._lastRunAt = Date.now();
    this.stats.cycles++;
    this.stats.lastRunAt = new Date().toISOString();

    const idleMs = _minutes(this.config.channelDistillerIdleMinutes, DEFAULT_IDLE_MINUTES) * 60_000;
    const batchSize = Math.max(1, Math.floor(Number(this.config.channelDistillerBatchSize) || DEFAULT_BATCH_SIZE));
    const now = Date.now();
    let checked = 0;
    let distilled = 0;
    let promoted = 0;

    try {
      const graphs = (this.registry.list?.() || [])
        .filter(g => g.role === 'channel' && g.distillDirty)
        .filter(g => {
          if (force) return true;
          const lastActivity = Date.parse(g.lastActivityAt || g.distillDirtySince || 0);
          return Number.isFinite(lastActivity) && now - lastActivity >= idleMs;
        })
        .slice(0, batchSize);

      for (const graph of graphs) {
        checked++;
        const result = await this.distillGraph(graph);
        if (result?.distilled) distilled++;
        if (Number.isFinite(result?.promoted)) promoted += result.promoted;
      }

      this.stats.graphsChecked += checked;
      this.stats.graphsDistilled += distilled;
      this.stats.promoted += promoted;
      return { checked, distilled, promoted };
    } finally {
      this._running = false;
    }
  }

  async distillGraph(graph) {
    const slug = graph?.slug;
    if (!slug) return { skipped: 'missing-slug' };
    const db = this.learner.getGraphDb?.(slug);
    if (!db) return { skipped: 'missing-db' };

    graphEvents.emit('change', { op: 'channel:distill-start', graph: slug, source: SOURCE });
    try {
      const digest = this._collectDigest(db, graph);
      if (digest.length === 0) {
        this.registry.recordChannelGraphDistill?.(slug, { success: true, promoted: 0, candidates: 0 });
        graphEvents.emit('change', { op: 'channel:distill-done', graph: slug, promoted: 0, empty: true, source: SOURCE });
        return { distilled: true, promoted: 0, candidates: 0 };
      }

      const parsed = await this._askLlm(graph, digest);
      const promoted = this._promoteReusable(parsed, slug);
      this.registry.recordChannelGraphDistill?.(slug, {
        success: true,
        promoted,
        candidates: digest.length,
      });
      graphEvents.emit('change', { op: 'channel:distill-done', graph: slug, promoted, candidates: digest.length, source: SOURCE });
      return { distilled: true, promoted, candidates: digest.length };
    } catch (e) {
      this.stats.errors++;
      this.registry.recordChannelGraphDistill?.(slug, { success: false, error: e.message });
      graphEvents.emit('change', { op: 'channel:distill-done', graph: slug, error: e.message, source: SOURCE });
      this.log.warn?.(`[channel-distill] ${slug} failed: ${e.message}`);
      return { error: e.message };
    }
  }

  _collectDigest(db, graph) {
    const since = graph.distillDirtySince || graph.lastDistilledAt || null;
    const nodeLimit = Math.max(5, Math.min(50, Number(this.config.channelDistillerNodeLimit) || 24));
    const attrLimit = Math.max(4, Math.min(30, Number(this.config.channelDistillerAttrLimit) || 12));
    const params = since ? [since, since, nodeLimit] : [nodeLimit];
    const whereRecent = since ? 'AND (a.created >= ? OR a.updated_at >= ?)' : '';
    const nodes = db.prepare(`
      SELECT n.id, n.label, n.type, n.description, n.importance, MAX(a.created) AS last_attr
        FROM nodes n
        JOIN aspects asp ON asp.node_id = n.id
        JOIN attributes a ON a.aspect_id = asp.id
       WHERE n.id NOT LIKE 'ref-%'
         AND n.type NOT IN ('person', 'channel', 'project', 'session', 'event', 'place', 'organization')
         ${whereRecent}
       GROUP BY n.id
       ORDER BY datetime(last_attr) DESC, n.importance DESC
       LIMIT ?
    `).all(...params);

    const attrStmt = db.prepare(`
      SELECT asp.name AS aspect, a.content, a.importance, a.created
        FROM aspects asp
        JOIN attributes a ON a.aspect_id = asp.id
       WHERE asp.node_id = ?
       ORDER BY a.importance DESC, datetime(a.created) DESC, a.id DESC
       LIMIT ?
    `);

    return nodes
      .filter(n => ALLOWED_TYPES.has(String(n.type || '').toLowerCase()))
      .map(n => {
        const aspects = {};
        for (const row of attrStmt.all(n.id, attrLimit)) {
          const text = String(row.content || '').trim();
          if (!text || _looksChannelPrivate(text)) continue;
          const name = String(row.aspect || 'notes').slice(0, 40);
          if (!aspects[name]) aspects[name] = [];
          aspects[name].push(text.slice(0, 500));
        }
        return {
          id: n.id,
          label: n.label,
          type: n.type,
          description: String(n.description || '').slice(0, 300),
          aspects,
        };
      })
      .filter(n => Object.keys(n.aspects || {}).length > 0);
  }

  async _askLlm(graph, digest) {
    const prompt = [
      'You are distilling a long-lived chat channel memory graph into reusable general knowledge.',
      '',
      'The channel graph is private and scoped to one external person or chat. Your job is to copy out ONLY lessons that are reusable across users, projects, or channels.',
      '',
      'Hard privacy rules:',
      '- Do not include person names, usernames, chat IDs, user IDs, channel IDs, schedules, reminders, report formats, notification preferences, recurring jobs, private plans, or commitments.',
      '- Do not include facts that are only true for this one channel user.',
      '- Do not include pairing codes, access tokens, credentials, or operational authorization details.',
      '- If a lesson needs a person or channel identity to be useful, leave it in the channel graph and omit it.',
      '',
      'Good candidates:',
      '- Technical fixes, library/tool gotchas, protocol behavior, durable UI/backend patterns, or general integration lessons discovered while helping through the channel.',
      '- Channel-independent agent workflow lessons, if sanitized.',
      '',
      `Channel graph: ${graph.slug}`,
      'Candidate digest:',
      JSON.stringify(digest, null, 2),
      '',
      'Output valid JSON only. If nothing is safe to promote, return empty arrays.',
      '{',
      '  "createNodes": [',
      '    { "nodeId": "telegram-bot-api", "label": "Telegram Bot API", "type": "service", "description": "Bot integration API", "aspects": [{ "name": "gotchas", "attributes": ["Reusable sanitized lesson"] }] }',
      '  ],',
      '  "appendNotes": [',
      '    { "targetNodeId": "existing-or-new-node-id", "aspect": "gotchas", "content": "Reusable sanitized lesson" }',
      '  ]',
      '}',
    ].join('\n');

    const model = modelForTier('casual') || this.config.learnerModel || this.config.casualModel || this.config.model;
    const params = {
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    };
    const text = await this._callLlm(params);
    return _parseJSON(text) || { createNodes: [], appendNotes: [] };
  }

  async _callLlm(params) {
    let text = '';
    try {
      const stream = this.client.messages.stream(params);
      if (stream && typeof stream.finalMessage === 'function') {
        const result = await stream.finalMessage();
        text = (result?.content || []).find(b => b.type === 'text')?.text || '';
      } else if (stream && typeof stream.on === 'function') {
        await new Promise((resolve, reject) => {
          stream.on('text', chunk => { text += chunk; });
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      } else {
        const response = await this.client.messages.create(params);
        text = (response?.content || []).find(b => b.type === 'text')?.text || '';
      }
    } catch (e) {
      this.log.debug?.(`[channel-distill] stream failed (${e.message}), falling back to create()`);
      const response = await this.client.messages.create(params);
      text = (response?.content || []).find(b => b.type === 'text')?.text || '';
    }
    return text;
  }

  _promoteReusable(parsed, sourceSlug) {
    const registry = this.registry;
    const kbSlug = registry?.getGeneralKnowledgeSlug?.();
    const kb = kbSlug ? this.learner.getGraphDb?.(kbSlug) : null;
    if (!kb) return 0;

    let promoted = 0;
    const upsert = (nodeIdRaw, labelRaw, typeRaw, descriptionRaw, lessonRaw, aspectRaw) => {
      const clean = _sanitizeLesson(lessonRaw);
      if (!clean) return false;
      const type = String(typeRaw || 'concept').toLowerCase();
      if (!ALLOWED_TYPES.has(type)) return false;
      const id = _nodeId(nodeIdRaw || labelRaw);
      if (!id || id.startsWith('channel-') || id.startsWith('user-') || id.startsWith('person-')) return false;
      if (_looksChannelPrivate(`${id} ${labelRaw || ''} ${descriptionRaw || ''} ${clean}`)) return false;

      const label = String(labelRaw || id).slice(0, 120);
      const description = String(descriptionRaw || clean).replace(/\s+/g, ' ').slice(0, 500);
      const existing = kb.prepare('SELECT id, description FROM nodes WHERE id = ?').get(id);
      if (!existing) {
        kb.prepare(
          'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, 6, 1, ?, ?, ?, ?)'
        ).run(id, label, type, description, 'general-kb', SOURCE, new Date().toISOString(), JSON.stringify({
          sourceChannelGraph: sourceSlug,
          confidence: 'conservative-auto',
        }));
      } else {
        kb.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      }

      const source = `source: channel/${sourceSlug}`;
      const attr = `${clean} (${source})`;
      if (_aspectWithAttr(kb, id, 'reusable_lessons', attr, SOURCE)) {
        _aspectWithAttr(kb, id, 'summary', clean, SOURCE);
        if (aspectRaw && aspectRaw !== 'reusable_lessons') {
          _aspectWithAttr(kb, id, String(aspectRaw).replace(/[^a-z0-9_]/gi, '_').slice(0, 40) || 'notes', clean, SOURCE);
        }
        graphEvents.emit('change', { op: 'attribute:create', nodeId: id, aspect: 'reusable_lessons', content: attr, source: SOURCE });
        return true;
      }
      return false;
    };

    for (const c of Array.isArray(parsed?.createNodes) ? parsed.createNodes : []) {
      const type = String(c?.type || 'concept').toLowerCase();
      if (!ALLOWED_TYPES.has(type)) continue;
      for (const asp of Array.isArray(c?.aspects) ? c.aspects : []) {
        for (const attr of Array.isArray(asp?.attributes) ? asp.attributes : []) {
          if (upsert(c.nodeId, c.label, type, c.description, attr, asp.name)) promoted++;
        }
      }
    }
    for (const a of Array.isArray(parsed?.appendNotes) ? parsed.appendNotes : []) {
      if (upsert(a.targetNodeId, a.targetNodeId, 'concept', 'Reusable channel lesson', a.content, a.aspect)) promoted++;
    }

    try { registry.refreshStats(kbSlug); } catch {}
    return promoted;
  }
}

module.exports = { ChannelDistiller };
