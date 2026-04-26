/**
 * skills.js — Shared Skills System
 *
 * Manages a shared knowledge base across all SPORE agents.
 * Skills are markdown files with YAML frontmatter stored in a shared volume.
 * An auto-maintained _index.json provides fast catalog lookups.
 */

const fs = require('fs');
const path = require('path');

class SkillsManager {
  constructor(logger, skillsDir) {
    this.log = logger || console;
    this._skillsDir = skillsDir || '/shared/skills';
    this._indexPath = path.join(this._skillsDir, '_index.json');
    this._indexCache = null;
    this._indexMtime = 0;
  }

  get available() {
    try { return fs.existsSync(this._skillsDir) && fs.statSync(this._skillsDir).isDirectory(); } catch { return false; }
  }

  // ── Index management ──

  _readIndex() {
    try {
      const stat = fs.statSync(this._indexPath);
      if (stat.mtimeMs === this._indexMtime && this._indexCache) return this._indexCache;
      const raw = fs.readFileSync(this._indexPath, 'utf8');
      this._indexCache = JSON.parse(raw);
      this._indexMtime = stat.mtimeMs;
      return this._indexCache;
    } catch {
      return [];
    }
  }

  _writeIndex(index) {
    fs.writeFileSync(this._indexPath, JSON.stringify(index, null, 2), 'utf8');
    this._indexCache = index;
    try { this._indexMtime = fs.statSync(this._indexPath).mtimeMs; } catch (e) { this.log.warn('[skills] fs.statSync failed: ' + e.message); }
  }

  _rebuildIndex() {
    if (!this.available) return [];
    const entries = fs.readdirSync(this._skillsDir).filter(f => f.endsWith('.md'));
    const index = [];
    for (const file of entries) {
      try {
        const content = fs.readFileSync(path.join(this._skillsDir, file), 'utf8');
        const meta = this._parseFrontmatter(content);
        const slug = file.replace(/\.md$/, '');
        index.push({
          slug,
          title: meta.title || slug,
          tags: meta.tags || [],
          author: meta.author || 'unknown',
          summary: meta.summary || '',
          created: meta.created || null,
          updated: meta.updated || null,
        });
      } catch (e) {
        this.log.warn?.(`[skills] Failed to index ${file}: ${e.message}`);
      }
    }
    this._writeIndex(index);
    return index;
  }

  // ── Frontmatter parsing ──

  _parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return {};
    const yaml = match[1];
    const meta = {};
    for (const line of yaml.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      } else {
        meta[key] = val.replace(/^['"]|['"]$/g, '');
      }
    }
    return meta;
  }

  _buildFrontmatter(meta) {
    const lines = ['---'];
    if (meta.title) lines.push(`title: ${meta.title}`);
    if (meta.tags?.length) lines.push(`tags: [${meta.tags.join(', ')}]`);
    if (meta.author) lines.push(`author: ${meta.author}`);
    if (meta.summary) lines.push(`summary: ${meta.summary}`);
    if (meta.created) lines.push(`created: ${meta.created}`);
    if (meta.updated) lines.push(`updated: ${meta.updated}`);
    lines.push('---');
    return lines.join('\n');
  }

  _stripFrontmatter(content) {
    return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  }

  // ── Public API (for tools) ──

  list(query, tags) {
    if (!this.available) return { error: 'Shared skills directory not available' };
    let index = this._readIndex();
    if (!index.length) index = this._rebuildIndex();

    if (tags?.length) {
      const tagSet = new Set(tags.map(t => t.toLowerCase()));
      index = index.filter(s => s.tags.some(t => tagSet.has(t.toLowerCase())));
    }

    if (query) {
      const q = query.toLowerCase();
      index = index.filter(s =>
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    return { skills: index, total: index.length };
  }

  read(slug) {
    if (!this.available) return { error: 'Shared skills directory not available' };
    const filePath = path.join(this._skillsDir, `${slug}.md`);
    if (!filePath.startsWith(this._skillsDir)) return { error: 'Invalid slug' };
    try {
      if (!fs.existsSync(filePath)) return { error: `Skill not found: ${slug}` };
      const content = fs.readFileSync(filePath, 'utf8');
      const meta = this._parseFrontmatter(content);
      const body = this._stripFrontmatter(content);
      return { slug, ...meta, content: body };
    } catch (e) {
      return { error: `Failed to read skill: ${e.message}` };
    }
  }

  write(slug, { title, tags, author, summary, content, mode }) {
    if (!this.available) return { error: 'Shared skills directory not available' };
    if (!slug || !content) return { error: 'slug and content are required' };

    const safeSlug = slug.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    const filePath = path.join(this._skillsDir, `${safeSlug}.md`);
    if (!filePath.startsWith(this._skillsDir)) return { error: 'Invalid slug' };

    const now = new Date().toISOString().split('T')[0];
    let existingMeta = {};
    let existingBody = '';

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      existingMeta = this._parseFrontmatter(existing);
      existingBody = this._stripFrontmatter(existing);
    }

    const meta = {
      title: title || existingMeta.title || safeSlug,
      tags: tags || existingMeta.tags || [],
      author: author || existingMeta.author || 'unknown',
      summary: summary || existingMeta.summary || '',
      created: existingMeta.created || now,
      updated: now,
    };

    let finalBody;
    if (mode === 'append' && existingBody) {
      finalBody = existingBody + '\n\n' + content;
    } else {
      finalBody = content;
    }

    const fileContent = this._buildFrontmatter(meta) + '\n\n' + finalBody;
    fs.writeFileSync(filePath, fileContent, 'utf8');

    // Update index
    const index = this._readIndex();
    const idx = index.findIndex(s => s.slug === safeSlug);
    const entry = {
      slug: safeSlug,
      title: meta.title,
      tags: meta.tags,
      author: meta.author,
      summary: meta.summary,
      created: meta.created,
      updated: meta.updated,
    };
    if (idx >= 0) index[idx] = entry;
    else index.push(entry);
    this._writeIndex(index);

    this.log.info?.(`[skills] ${idx >= 0 ? 'Updated' : 'Created'} skill: ${safeSlug} by ${meta.author}`);
    return { ok: true, slug: safeSlug, action: idx >= 0 ? 'updated' : 'created' };
  }

  remove(slug) {
    if (!this.available) return { error: 'Shared skills directory not available' };
    const filePath = path.join(this._skillsDir, `${slug}.md`);
    if (!filePath.startsWith(this._skillsDir)) return { error: 'Invalid slug' };
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const index = this._readIndex().filter(s => s.slug !== slug);
      this._writeIndex(index);
      return { ok: true, slug };
    } catch (e) {
      return { error: `Failed to delete skill: ${e.message}` };
    }
  }

  getCatalogSummary() {
    if (!this.available) return null;
    let index = this._readIndex();
    if (!index.length) index = this._rebuildIndex();
    if (!index.length) return null;
    return index.map(s => `- **${s.title}** (\`${s.slug}\`) — ${s.summary || 'no description'}${s.tags.length ? ` [${s.tags.join(', ')}]` : ''}`).join('\n');
  }
}

module.exports = SkillsManager;
