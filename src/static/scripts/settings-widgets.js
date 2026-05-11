// settings-widgets.js — small reusable settings UI primitives.
// Keep this dependency-free: it is loaded before settings.js and is also
// safe for plugin panes that render after the modal is already mounted.
(function () {
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  function attrs(map = {}) {
    return Object.entries(map)
      .filter(([, v]) => v !== false && v !== null && v !== undefined)
      .map(([k, v]) => v === true ? escapeAttr(k) : `${escapeAttr(k)}="${escapeAttr(v)}"`)
      .join(' ');
  }

  function note(text, opts = {}) {
    if (!text) return '';
    const classes = ['settings-note'];
    if (opts.muted) classes.push('settings-muted');
    if (opts.soft) classes.push('settings-muted-soft');
    if (opts.className) classes.push(opts.className);
    return `<div class="${classes.join(' ')}">${escapeHtml(text)}</div>`;
  }

  function field(opts = {}) {
    const id = opts.id || '';
    const classes = ['settings-field'];
    if (opts.className) classes.push(opts.className);
    const label = opts.label
      ? `<label${id ? ` for="${escapeAttr(id)}"` : ''}>${escapeHtml(opts.label)}</label>`
      : '';
    const attrText = attrs(opts.attrs || {});
    return `<div class="${classes.join(' ')}"${attrText ? ` ${attrText}` : ''}>${label}${opts.control || ''}${note(opts.help, { soft: true })}</div>`;
  }

  function input(opts = {}) {
    const type = opts.type || 'text';
    const attrMap = {
      id: opts.id,
      type,
      value: type === 'checkbox' ? undefined : (opts.value ?? ''),
      placeholder: opts.placeholder,
      min: opts.min,
      max: opts.max,
      step: opts.step,
      autocomplete: opts.autocomplete,
      checked: type === 'checkbox' ? !!opts.checked : undefined,
      ...opts.attrs,
    };
    return `<input ${attrs(attrMap)}>`;
  }

  function select(opts = {}) {
    const selected = String(opts.value ?? '');
    const options = (opts.options || []).map(o => {
      const value = String(o.value ?? '');
      return `<option value="${escapeAttr(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(o.label || value)}</option>`;
    }).join('');
    return `<select ${attrs({ id: opts.id, ...opts.attrs })}>${options}</select>`;
  }

  function textarea(opts = {}) {
    return `<textarea ${attrs({ id: opts.id, rows: opts.rows || 3, placeholder: opts.placeholder, ...opts.attrs })}>${escapeHtml(opts.value ?? '')}</textarea>`;
  }

  function segmented(opts = {}) {
    const id = opts.id;
    const selected = String(opts.value ?? '');
    const classes = ['settings-widget-segmented'];
    if (opts.className) classes.push(opts.className);
    const buttons = (opts.options || []).map(o => {
      const value = String(o.value ?? '');
      const active = value === selected;
      const title = o.description || o.help || o.label || value;
      return `<button class="settings-segmented-btn${active ? ' active' : ''}" type="button" data-settings-segment-value="${escapeAttr(value)}" aria-pressed="${active ? 'true' : 'false'}" title="${escapeAttr(title)}">${escapeHtml(o.label || value)}</button>`;
    }).join('');
    return `${input({ id, type: 'hidden', value: selected, attrs: { 'data-settings-segmented-input': true } })}<div class="${classes.join(' ')}" ${attrs({ 'data-settings-segmented-for': id, ...opts.attrs })}>${buttons}</div>`;
  }

  function setSegmentedValue(inputOrId, value) {
    const input = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    if (!input) return;
    const nextGroup = input.nextElementSibling?.matches?.('[data-settings-segmented-for]') ? input.nextElementSibling : null;
    const parentGroups = Array.from(input.parentElement?.querySelectorAll?.('[data-settings-segmented-for]') || []);
    const group = nextGroup || parentGroups.find(el => el.getAttribute('data-settings-segmented-for') === input.id);
    const next = String(value ?? '');
    input.value = next;
    group?.querySelectorAll('[data-settings-segment-value]').forEach(btn => {
      const active = btn.getAttribute('data-settings-segment-value') === next;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function bindSegmentedControls(root = document) {
    const target = root === document ? document : root;
    if (target.__settingsSegmentedBound) return;
    target.__settingsSegmentedBound = true;
    target.addEventListener('click', e => {
      const btn = e.target?.closest?.('[data-settings-segment-value]');
      if (!btn) return;
      const group = btn.closest('[data-settings-segmented-for]');
      const inputId = group?.getAttribute('data-settings-segmented-for');
      const input = inputId ? document.getElementById(inputId) : null;
      if (!input) return;
      const value = btn.getAttribute('data-settings-segment-value') || '';
      setSegmentedValue(input, value);
      group.dispatchEvent(new CustomEvent('settings-segmented-change', {
        bubbles: true,
        detail: { id: inputId, value },
      }));
    });
  }

  window.SettingsWidgets = {
    escapeHtml,
    escapeAttr,
    attrs,
    note,
    field,
    input,
    select,
    textarea,
    segmented,
    setSegmentedValue,
    bindSegmentedControls,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bindSegmentedControls(document), { once: true });
  } else {
    bindSegmentedControls(document);
  }
})();
