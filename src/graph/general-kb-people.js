'use strict';

const {
  ensureGeneralKbPromotionAnchors,
  linkPromotedGeneralKbNode,
  sanitizeAspectName,
  sanitizeNodeId,
} = require('./general-kb-promotion');

const SAFE_PERSON_ASPECTS = new Set([
  'public_context',
  'team_context',
  'shared_context',
  'work_context',
  'role',
  'roles',
  'maintainership',
  'authorship',
  'collaboration',
  'projects',
  'contributions',
]);

function _isGenericPersonLabel(value) {
  const label = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return !label || ['person', 'user', 'unknown', 'anonymous', 'someone', 'operator', 'this-user', 'that-user'].includes(label);
}

function _personNodeId(nodeIdRaw, labelRaw) {
  const id = sanitizeNodeId(nodeIdRaw || labelRaw);
  if (!id) return null;
  if (/^(?:channel|chat|telegram|slack|discord)-/.test(id)) return null;
  if (/^(?:user|web-user)-/.test(id)) {
    const labelId = sanitizeNodeId(labelRaw || '');
    if (labelId && !/^(?:user|web-user|channel|chat|telegram|slack|discord)-/.test(labelId)) return labelId;
    return null;
  }
  return id;
}

function _rejectsPrivatePersonText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return true;
  if (/(sk-[a-z0-9]|ghp_[a-z0-9]|password\s*=|api[_-]?key\s*=|secret\s*=|bearer\s+[a-z0-9._-]+)/i.test(raw)) return true;
  if (/@[a-z0-9_]{3,}/i.test(raw)) return true;
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(raw)) return true;
  if (/\b(?:user|chat|channel|telegram|slack|discord)[ _-]?id\b/i.test(raw)) return true;
  if (/\b(?:pairing code|approved user|dm policy|private dm)\b/i.test(raw)) return true;
  if (/\b(?:remind|reminder|schedule|cron job|daily report|weekly report|notification preference|timezone|wake me|send me|send him|send her)\b/i.test(raw)) return true;
  if (/\b(?:preference|prefers|likes|dislikes|home address|phone|personal)\b/i.test(raw)) return true;
  if (/(^|[\\/])\.spore-code[\\/]|scratch helper|scratch_helpers|local workspace|repository path|source code located|untracked files/i.test(raw)) return true;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(raw)) return true;
  if (/\b-?\d{8,}\b/.test(raw)) return true;
  return false;
}

function _looksSharedPersonContext(text, aspectName = '') {
  const aspect = sanitizeAspectName(aspectName, '').toLowerCase();
  if (SAFE_PERSON_ASPECTS.has(aspect)) return true;
  return /\b(?:maintain|maintainer|author|owner|lead|team|member|collaborat|contribut|review|responsible|works? on|working on|built|designed|project|role|computing work)\b/i.test(String(text || ''));
}

function _sanitizeSharedPersonFact(text, aspectName = '') {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 8) return null;
  if (_rejectsPrivatePersonText(raw)) return null;
  if (!_looksSharedPersonContext(raw, aspectName)) return null;
  return raw
    .replace(/\s*\(source:\s*[^)]+\)\s*$/i, '')
    .replace(/\/(?:home|Users|mnt|app|workspace|data)\/[^\s`'")]+/g, '<project-path>')
    .replace(/[A-Za-z]:\\[^\s`'")]+/g, '<project-path>')
    .replace(/\b-?\d{6,}\b/g, '<id>')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function _aspectWithAttr(db, nodeId, aspectName, content, source) {
  const clean = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!clean) return false;
  let asp = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, aspectName);
  if (!asp) {
    db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 7, ?)').run(nodeId, aspectName, source);
    asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  const dup = db.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, clean);
  if (dup) return false;
  db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 7, ?, ?)')
    .run(asp.id, clean, source, source);
  return true;
}

function _resolveGeneralKb(learner) {
  const registry = learner?._graphRegistry || learner?._appContext?.tools?._graphRegistry || null;
  const slug = registry?.getGeneralKnowledgeSlug?.();
  const db = slug && learner?.getGraphDb ? learner.getGraphDb(slug) : null;
  return { registry, slug, db };
}

function syncPersonToGeneralKb(learner, personRaw, { source = 'person-distill', sourceGraph = null, sourceRole = null } = {}) {
  const { registry, slug: kbSlug, db } = _resolveGeneralKb(learner);
  if (!db) return { synced: false, reason: 'missing-general-kb' };
  const id = _personNodeId(personRaw?.nodeId || personRaw?.targetNodeId || personRaw?.id, personRaw?.label);
  const label = String(personRaw?.label || id || '').trim().slice(0, 120);
  if (!id || _isGenericPersonLabel(label)) return { synced: false, reason: 'generic-person' };
  if (_rejectsPrivatePersonText(`${id} ${label}`)) return { synced: false, reason: 'private-person-id' };

  const safeDescription = _sanitizeSharedPersonFact(personRaw?.description, 'public_context');
  const safeFacts = [];
  const aspectInputs = [];
  for (const asp of Array.isArray(personRaw?.aspects) ? personRaw.aspects : []) aspectInputs.push(asp);
  if (personRaw?.content) {
    aspectInputs.push({ name: personRaw.aspect || 'shared_context', attributes: [personRaw.content] });
  }
  for (const asp of aspectInputs) {
    const aspectName = sanitizeAspectName(asp?.name || 'shared_context', 'shared_context');
    for (const attrRaw of Array.isArray(asp?.attributes) ? asp.attributes : []) {
      const clean = _sanitizeSharedPersonFact(attrRaw, aspectName);
      if (clean) safeFacts.push({ aspectName, clean });
    }
  }

  if (!safeDescription && safeFacts.length === 0) return { synced: false, reason: 'no-shared-person-facts' };
  const description = safeDescription || 'Person represented by sanitized shared knowledge.';
  ensureGeneralKbPromotionAnchors(db, source);

  const existing = db.prepare('SELECT id, description FROM nodes WHERE id = ?').get(id);
  let changed = false;
  const extra = JSON.stringify({
    sourceGraph,
    sourceRole,
    confidence: 'conservative-auto',
  });
  if (!existing) {
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, 6, 1, ?, ?, ?, ?)'
    ).run(id, label, 'person', description, 'general-kb', source, new Date().toISOString(), extra);
    changed = true;
  } else {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    if (safeDescription && (!existing.description || /^person represented by sanitized/i.test(String(existing.description)))) {
      db.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?').run(safeDescription, id);
      changed = true;
    }
  }

  for (const fact of safeFacts) {
    if (_aspectWithAttr(db, id, fact.aspectName, fact.clean, source)) changed = true;
  }
  const link = linkPromotedGeneralKbNode(db, id, 'person', source);
  if (link.edgesCreated) changed = true;
  try { registry?.refreshStats?.(kbSlug); } catch {}
  return { synced: true, changed, nodeId: id, graph: kbSlug };
}

function promoteScopedPeopleToGeneralKb(learner, registry, { source = 'scoped-people-yield', roles = ['project', 'user', 'channel'] } = {}) {
  const graphRegistry = registry || learner?._graphRegistry || learner?._appContext?.tools?._graphRegistry || null;
  if (!learner?.getGraphDb || !graphRegistry?.list) return { scanned: 0, promoted: 0, skipped: true };
  const wanted = new Set(roles);
  let scanned = 0;
  let promoted = 0;
  for (const graph of graphRegistry.list() || []) {
    const role = String(graph?.role || '').toLowerCase();
    if (!wanted.has(role)) continue;
    const db = learner.getGraphDb(graph.slug);
    if (!db) continue;
    const people = db.prepare("SELECT id, label, description FROM nodes WHERE type = 'person' ORDER BY updated DESC, id LIMIT 200").all();
    for (const person of people) {
      scanned++;
      const aspects = db.prepare(`
        SELECT asp.name AS aspect, a.content
          FROM aspects asp
          JOIN attributes a ON a.aspect_id = asp.id
         WHERE asp.node_id = ?
         ORDER BY a.importance DESC, datetime(a.created) DESC, a.id DESC
         LIMIT 60
      `).all(person.id);
      const grouped = new Map();
      for (const row of aspects) {
        const aspectName = sanitizeAspectName(row.aspect || 'shared_context', 'shared_context');
        const clean = _sanitizeSharedPersonFact(row.content, aspectName);
        if (!clean) continue;
        if (!grouped.has(aspectName)) grouped.set(aspectName, []);
        grouped.get(aspectName).push(clean);
      }
      const result = syncPersonToGeneralKb(learner, {
        nodeId: person.id,
        label: person.label,
        description: person.description,
        aspects: Array.from(grouped, ([name, attributes]) => ({ name, attributes })),
      }, { source, sourceGraph: graph.slug, sourceRole: role });
      if (result.synced && result.changed) promoted++;
    }
  }
  return { scanned, promoted };
}

module.exports = {
  promoteScopedPeopleToGeneralKb,
  syncPersonToGeneralKb,
};
