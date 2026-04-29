// shared-skills.js — Shared Skills panel (search + install/view skill artifacts).
// Extracted from src/static/scripts/app.js (was lines 12431-12604 of the post-Phase-2 monolith).

// ── Shared Skills Panel ──
let _skCache = [];

async function skLoadList(query) {
  const list = document.getElementById('sk-list');
  if (!list) return;
  const url = query ? `${API}/api/skills?q=${encodeURIComponent(query)}` : `${API}/api/skills`;
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _skCache = data.skills || [];
    skRenderList(_skCache);
  } catch (e) {
    list.innerHTML = `<div id="sk-list-empty">Failed to load skills: ${esc(e.message)}</div>`;
  }
}

function skRenderList(skills) {
  const list = document.getElementById('sk-list');
  document.getElementById('sk-viewer').style.display = 'none';
  document.getElementById('sk-editor').style.display = 'none';
  list.style.display = '';
  document.getElementById('sk-toolbar').style.display = '';
  if (!skills.length) {
    list.innerHTML = '<div id="sk-list-empty">No skills yet. Agents can create them with <code>skill_update</code>, or click <strong>+ New</strong>.</div>';
    return;
  }
  list.innerHTML = skills.map(s => `
    <div class="sk-entry" data-slug="${esc(s.slug)}">
      <div class="sk-entry-title">${esc(s.title || s.slug)}</div>
      <div class="sk-entry-meta">
        <span>${esc(s.author || '?')}</span>
        <span>${s.updated || s.created || ''}</span>
        ${(s.tags || []).map(t => `<span class="sk-tag">${esc(t)}</span>`).join('')}
      </div>
      ${s.summary ? `<div class="sk-entry-summary">${esc(s.summary)}</div>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('.sk-entry').forEach(el => {
    el.onclick = () => skViewSkill(el.dataset.slug);
  });
}

async function skViewSkill(slug) {
  const viewer = document.getElementById('sk-viewer');
  const list = document.getElementById('sk-list');
  const editor = document.getElementById('sk-editor');
  try {
    const res = await fetch(`${API}/api/skills/read?slug=${encodeURIComponent(slug)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }

    document.getElementById('sk-viewer-title').textContent = data.title || data.slug;
    const meta = document.getElementById('sk-viewer-meta');
    meta.innerHTML = [
      `<span>by <strong>${esc(data.author || '?')}</strong></span>`,
      data.updated ? `<span>updated ${esc(data.updated)}</span>` : '',
      ...(data.tags || []).map(t => `<span class="sk-tag">${esc(t)}</span>`),
    ].filter(Boolean).join('');

    const contentEl = document.getElementById('sk-viewer-content');
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      contentEl.innerHTML = DOMPurify.sanitize(marked.parse(data.content || ''), {
        ADD_ATTR: ['target'],
        ALLOWED_TAGS: ['p','br','strong','em','a','code','pre','h1','h2','h3','h4','h5','h6',
          'ul','ol','li','blockquote','table','thead','tbody','tr','th','td','hr','del','span','div','img'],
      });
    } else {
      contentEl.textContent = data.content || '';
    }

    viewer._currentSlug = slug;
    viewer._currentData = data;
    list.style.display = 'none';
    editor.style.display = 'none';
    document.getElementById('sk-toolbar').style.display = 'none';
    viewer.style.display = 'flex';
  } catch (e) {
    toast('Failed to load skill: ' + e.message, true);
  }
}

function skOpenEditor(existing) {
  const editor = document.getElementById('sk-editor');
  document.getElementById('sk-list').style.display = 'none';
  document.getElementById('sk-viewer').style.display = 'none';
  document.getElementById('sk-toolbar').style.display = 'none';
  editor.style.display = 'flex';

  if (existing) {
    document.getElementById('sk-editor-title').textContent = 'Edit Skill';
    document.getElementById('sk-field-slug').value = existing.slug || '';
    document.getElementById('sk-field-slug').readOnly = true;
    document.getElementById('sk-field-title').value = existing.title || '';
    document.getElementById('sk-field-tags').value = (existing.tags || []).join(', ');
    document.getElementById('sk-field-summary').value = existing.summary || '';
    document.getElementById('sk-field-content').value = existing.content || '';
  } else {
    document.getElementById('sk-editor-title').textContent = 'New Skill';
    document.getElementById('sk-field-slug').value = '';
    document.getElementById('sk-field-slug').readOnly = false;
    document.getElementById('sk-field-title').value = '';
    document.getElementById('sk-field-tags').value = '';
    document.getElementById('sk-field-summary').value = '';
    document.getElementById('sk-field-content').value = '';
  }
}

async function skSaveSkill() {
  const slug = document.getElementById('sk-field-slug').value.trim();
  const content = document.getElementById('sk-field-content').value;
  if (!slug) { toast('Slug is required', true); return; }
  if (!content) { toast('Content is required', true); return; }
  const tags = document.getElementById('sk-field-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const body = {
    slug,
    title: document.getElementById('sk-field-title').value.trim() || slug,
    tags,
    summary: document.getElementById('sk-field-summary').value.trim(),
    content,
    author: 'web-ui',
  };
  try {
    const res = await fetch(`${API}/api/skills/save`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast(`Skill ${data.action}: ${slug}`);
    skLoadList();
  } catch (e) {
    toast('Save failed: ' + e.message, true);
  }
}

async function skDeleteSkill(slug) {
  if (!confirm(`Delete skill "${slug}"?`)) return;
  try {
    const res = await fetch(`${API}/api/skills/delete?slug=${encodeURIComponent(slug)}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast(`Deleted: ${slug}`);
    skLoadList();
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

// Wire up skills UI events
document.getElementById('sk-refresh')?.addEventListener('click', () => skLoadList());
document.getElementById('sk-new')?.addEventListener('click', () => skOpenEditor(null));
document.getElementById('sk-back')?.addEventListener('click', () => skLoadList());
document.getElementById('sk-edit-btn')?.addEventListener('click', () => {
  const viewer = document.getElementById('sk-viewer');
  if (viewer._currentData) skOpenEditor(viewer._currentData);
});
document.getElementById('sk-delete-btn')?.addEventListener('click', () => {
  const viewer = document.getElementById('sk-viewer');
  if (viewer._currentSlug) skDeleteSkill(viewer._currentSlug);
});
document.getElementById('sk-editor-cancel')?.addEventListener('click', () => skLoadList());
document.getElementById('sk-editor-save')?.addEventListener('click', () => skSaveSkill());

let _skSearchTimeout;
document.getElementById('sk-search')?.addEventListener('input', (e) => {
  clearTimeout(_skSearchTimeout);
  _skSearchTimeout = setTimeout(() => skLoadList(e.target.value.trim()), 300);
});
