'use strict';

const GENERAL_KB_DISTILLATION_ID = 'general-kb-distillation';
const GENERAL_KB_PEOPLE_ID = 'general-kb-people';

function sanitizeNodeId(value, fallback = '') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeAspectName(value, fallback = 'notes') {
  return String(value || fallback)
    .replace(/[^a-z0-9_]/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || fallback;
}

function ensureGeneralKbNode(db, { id, label, type = 'concept', description = '', source = 'general-kb-promotion', importance = 6 } = {}) {
  const nodeId = sanitizeNodeId(id || label, 'node');
  if (!nodeId) return false;
  const existing = db.prepare('SELECT id, description FROM nodes WHERE id = ?').get(nodeId);
  const cleanLabel = String(label || nodeId).slice(0, 120);
  const cleanDescription = String(description || '').replace(/\s+/g, ' ').slice(0, 500);
  if (!existing) {
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
    ).run(
      nodeId,
      cleanLabel,
      String(type || 'concept').toLowerCase().slice(0, 40) || 'concept',
      cleanDescription,
      importance,
      'general-kb',
      source,
      new Date().toISOString(),
      JSON.stringify({ anchor: true }),
    );
    return true;
  }
  if (cleanDescription && (!existing.description || /^reusable knowledge distilled/i.test(String(existing.description)))) {
    db.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?').run(cleanDescription, nodeId);
  }
  return false;
}

function ensureGeneralKbEdge(db, source, target, type, { weight = 0.7, extractedWith = 'general-kb-promotion' } = {}) {
  const s = sanitizeNodeId(source);
  const t = sanitizeNodeId(target);
  const rel = String(type || '').replace(/[^a-z0-9_]/gi, '_').slice(0, 60);
  if (!s || !t || !rel || s === t) return false;
  const existing = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?').get(s, t, rel);
  if (existing) return false;
  db.prepare('INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, ?, ?)')
    .run(s, t, rel, weight, extractedWith);
  return true;
}

function ensureGeneralKbPromotionAnchors(db, source = 'general-kb-promotion') {
  ensureGeneralKbNode(db, {
    id: GENERAL_KB_DISTILLATION_ID,
    label: 'General KB Distillation',
    type: 'system',
    description: 'Sanitized knowledge promoted from scoped project, user, and channel graphs.',
    importance: 7,
    source,
  });
  ensureGeneralKbNode(db, {
    id: GENERAL_KB_PEOPLE_ID,
    label: 'General KB People',
    type: 'concept',
    description: 'People represented by sanitized shared knowledge.',
    importance: 6,
    source,
  });
  ensureGeneralKbEdge(db, GENERAL_KB_PEOPLE_ID, GENERAL_KB_DISTILLATION_ID, 'part_of', {
    weight: 0.8,
    extractedWith: source,
  });
}

function linkPromotedGeneralKbNode(db, nodeId, type, source = 'general-kb-promotion') {
  const id = sanitizeNodeId(nodeId);
  if (!id) return { edgesCreated: 0 };
  ensureGeneralKbPromotionAnchors(db, source);
  let edgesCreated = 0;
  if (id !== GENERAL_KB_DISTILLATION_ID && id !== GENERAL_KB_PEOPLE_ID) {
    if (ensureGeneralKbEdge(db, id, GENERAL_KB_DISTILLATION_ID, 'distilled_into', {
      weight: 0.6,
      extractedWith: source,
    })) edgesCreated++;
  }
  if (String(type || '').toLowerCase() === 'person' && id !== GENERAL_KB_PEOPLE_ID) {
    if (ensureGeneralKbEdge(db, id, GENERAL_KB_PEOPLE_ID, 'member_of', {
      weight: 0.9,
      extractedWith: source,
    })) edgesCreated++;
  }
  return { edgesCreated };
}

module.exports = {
  GENERAL_KB_DISTILLATION_ID,
  GENERAL_KB_PEOPLE_ID,
  ensureGeneralKbPromotionAnchors,
  ensureGeneralKbNode,
  ensureGeneralKbEdge,
  linkPromotedGeneralKbNode,
  sanitizeAspectName,
  sanitizeNodeId,
};
