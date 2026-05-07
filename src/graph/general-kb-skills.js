'use strict';

const {
  GENERAL_KB_DISTILLATION_ID,
  ensureGeneralKbEdge,
  ensureGeneralKbNode,
  ensureGeneralKbPromotionAnchors,
  linkPromotedGeneralKbNode,
  sanitizeNodeId,
} = require('./general-kb-promotion');

const GENERAL_KB_SKILLS_ID = 'general-kb-skills';

function _skillNodeId(slug) {
  const safe = sanitizeNodeId(slug);
  return safe ? `skill-${safe}`.slice(0, 80) : null;
}

function _aspectWithAttr(db, nodeId, aspectName, content, source, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 1200;
  const clean = opts.preserve
    ? String(content || '').replace(/\r\n/g, '\n').trim().slice(0, max)
    : String(content || '').replace(/\s+/g, ' ').trim().slice(0, max);
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

function _sanitizeSkillText(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length < 6) return null;
  if (/(sk-[a-z0-9]|ghp_[a-z0-9]|password\s*=|api[_-]?key\s*=|secret\s*=|bearer\s+[a-z0-9._-]+)/i.test(raw)) return null;
  return raw
    .replace(/\/(?:home|Users|mnt|app|workspace|data)\/[^\s`'")]+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s`'")]+/g, '<path>')
    .replace(/\b-?\d{6,}\b/g, '<id>')
    .slice(0, 800);
}

function _sanitizeSkillBlock(text) {
  const raw = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!raw || raw.length < 4) return null;
  if (/(sk-[a-z0-9]|ghp_[a-z0-9]|password\s*=|api[_-]?key\s*=|secret\s*=|bearer\s+[a-z0-9._-]+)/i.test(raw)) return null;
  return raw
    .replace(/\/(?:home|Users|mnt|app|workspace|data)\/[^\s`'")]+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s`'")]+/g, '<path>')
    .replace(/\b-?\d{8,}\b/g, '<id>')
    .slice(0, 1600);
}

function _textFromStructuredItem(item) {
  if (item == null) return '';
  if (typeof item !== 'object') return String(item);
  const command = item.command || item.cmd || item.shell || item.run;
  if (command) {
    const note = item.purpose || item.description || item.note || item.why;
    return [command, note].filter(Boolean).join(' — ');
  }
  const code = item.code || item.script || item.snippet || item.body;
  if (code) {
    const label = item.language || item.name || item.description || item.purpose;
    return [label ? `# ${label}` : '', code].filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function _asTextList(value, { preserve = false, limit = 12 } = {}) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const raw = _textFromStructuredItem(item);
    const clean = preserve ? _sanitizeSkillBlock(raw) : _sanitizeSkillText(raw);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function _firstText(...values) {
  for (const value of values) {
    const clean = _sanitizeSkillText(value);
    if (clean) return clean;
  }
  return null;
}

function normalizeGraphSkill(skill) {
  const skillSlug = sanitizeNodeId(skill?.slug || skill?.nodeId || skill?.id);
  const title = String(skill?.title || skill?.label || skillSlug || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const summary = _firstText(skill?.summary, skill?.description, skill?.overview);
  const applicability = _firstText(skill?.applicability, skill?.whenToUse, skill?.when_to_use, skill?.useCase, skill?.use_case);
  const tags = Array.isArray(skill?.tags)
    ? skill.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const prerequisites = _asTextList(skill?.prerequisites || skill?.requirements || skill?.setup);
  const commands = _asTextList(skill?.commands || skill?.command || skill?.cli, { preserve: true, limit: 16 });
  const steps = _asTextList(skill?.steps || skill?.procedure || skill?.workflow || skill?.instructions, { limit: 16 });
  const replay = _asTextList(
    skill?.replay || skill?.replaySteps || skill?.replay_steps || skill?.replayCode || skill?.replay_code || skill?.code || skill?.script || skill?.snippets,
    { preserve: true, limit: 10 }
  );
  const examples = _asTextList(skill?.examples || skill?.example, { preserve: true, limit: 8 });
  const lessons = _asTextList(skill?.lessons || skill?.notes, { limit: 12 });
  const gotchas = _asTextList(skill?.gotchas || skill?.pitfalls || skill?.warnings, { limit: 12 });
  const validation = _asTextList(skill?.validation || skill?.verification || skill?.checks || skill?.tests, { preserve: true, limit: 8 });
  const hasReplayArtifact = commands.length > 0 || replay.length > 0 || examples.length > 0;
  const hasProcedure = steps.length >= 2 || (steps.length >= 1 && hasReplayArtifact);
  const replayable = hasProcedure && hasReplayArtifact;
  return {
    skillSlug,
    title,
    summary,
    applicability,
    tags,
    prerequisites,
    commands,
    steps,
    replay,
    examples,
    lessons,
    gotchas,
    validation,
    replayable,
  };
}

function _resolveGeneralKb(learner) {
  const registry = learner?._graphRegistry || learner?._appContext?.tools?._graphRegistry || null;
  const slug = registry?.getGeneralKnowledgeSlug?.();
  const db = slug && learner?.getGraphDb ? learner.getGraphDb(slug) : null;
  return { registry, slug, db };
}

function syncSkillToGeneralKb(learner, skill, { source = 'skill-distill' } = {}) {
  const { registry, slug: kbSlug, db } = _resolveGeneralKb(learner);
  if (!db) return { synced: false, reason: 'missing-general-kb' };
  const normalized = normalizeGraphSkill(skill);
  const isSharedSkill = skill?.sharedSkill !== false;
  if (!isSharedSkill && !normalized.replayable) {
    return { synced: false, reason: 'non-replayable-skill' };
  }
  const skillSlug = normalized.skillSlug;
  const nodeId = _skillNodeId(skillSlug);
  if (!nodeId) return { synced: false, reason: 'missing-slug' };

  ensureGeneralKbPromotionAnchors(db, source);
  ensureGeneralKbNode(db, {
    id: GENERAL_KB_SKILLS_ID,
    label: 'General KB Skills',
    type: 'concept',
    description: 'Reusable procedural skills mirrored from the shared skills library.',
    importance: 7,
    source,
  });
  ensureGeneralKbEdge(db, GENERAL_KB_SKILLS_ID, GENERAL_KB_DISTILLATION_ID, 'part_of', {
    weight: 0.8,
    extractedWith: source,
  });

  const title = normalized.title || skillSlug;
  const summary = normalized.summary || `Replayable workflow ${skillSlug}`;
  const tags = normalized.tags;
  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId);
  const extra = JSON.stringify({
    skillSlug,
    sharedSkill: isSharedSkill,
    replayable: normalized.replayable,
    confidence: isSharedSkill ? 'mirrored-metadata' : 'distilled-workflow',
  });
  if (!existing) {
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, 7, 1, ?, ?, ?, ?)'
    ).run(nodeId, title, 'skill', summary, 'general-kb', source, new Date().toISOString(), extra);
  } else {
    db.prepare('UPDATE nodes SET label = ?, type = ?, description = ?, mentions = mentions + 1, updated = CURRENT_TIMESTAMP, extra = ? WHERE id = ?')
      .run(title, 'skill', summary, extra, nodeId);
  }

  let changed = !existing;
  if (_aspectWithAttr(db, nodeId, 'summary', summary, source)) changed = true;
  if (isSharedSkill && _aspectWithAttr(db, nodeId, 'skill_lookup', `Use skill_lookup({ action: "read", slug: "${skillSlug}" }) for the full shared skill.`, source)) changed = true;
  if (tags.length && _aspectWithAttr(db, nodeId, 'tags', tags.join(', '), source)) changed = true;
  if (normalized.applicability && _aspectWithAttr(db, nodeId, 'applicability', normalized.applicability, source)) changed = true;
  for (const prerequisite of normalized.prerequisites) {
    if (_aspectWithAttr(db, nodeId, 'prerequisites', prerequisite, source)) changed = true;
  }
  for (const command of normalized.commands) {
    if (_aspectWithAttr(db, nodeId, 'commands', command, source, { preserve: true, max: 1600 })) changed = true;
  }
  for (const step of normalized.steps) {
    if (_aspectWithAttr(db, nodeId, 'steps', step, source)) changed = true;
  }
  for (const item of normalized.replay) {
    if (_aspectWithAttr(db, nodeId, 'replay', item, source, { preserve: true, max: 1600 })) changed = true;
  }
  for (const example of normalized.examples) {
    if (_aspectWithAttr(db, nodeId, 'examples', example, source, { preserve: true, max: 1600 })) changed = true;
  }
  for (const lesson of normalized.lessons) {
    if (_aspectWithAttr(db, nodeId, 'lessons', lesson, source)) changed = true;
  }
  for (const gotcha of normalized.gotchas) {
    if (_aspectWithAttr(db, nodeId, 'gotchas', gotcha, source)) changed = true;
  }
  for (const check of normalized.validation) {
    if (_aspectWithAttr(db, nodeId, 'validation', check, source, { preserve: true, max: 1600 })) changed = true;
  }
  const link = linkPromotedGeneralKbNode(db, nodeId, 'skill', source);
  if (link.edgesCreated) changed = true;
  if (ensureGeneralKbEdge(db, nodeId, GENERAL_KB_SKILLS_ID, 'member_of', { weight: 0.9, extractedWith: source })) changed = true;

  try { registry?.refreshStats?.(kbSlug); } catch {}
  return { synced: true, changed, nodeId, slug: skillSlug, graph: kbSlug };
}

function syncSkillsIndexToGeneralKb(learner, skills, { source = 'skills-startup-sync' } = {}) {
  if (!skills?.available) return { synced: 0, skipped: true };
  const list = skills.list();
  const entries = Array.isArray(list?.skills) ? list.skills : [];
  let synced = 0;
  for (const entry of entries) {
    const result = syncSkillToGeneralKb(learner, entry, { source });
    if (result.synced) synced++;
  }
  return { synced };
}

module.exports = {
  GENERAL_KB_SKILLS_ID,
  normalizeGraphSkill,
  syncSkillToGeneralKb,
  syncSkillsIndexToGeneralKb,
};
