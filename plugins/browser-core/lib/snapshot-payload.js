// browser-snapshot-payload.js — JS expression evaluated in the active
// tab by both browser backends (zendriver_browser.py and
// playwright-browser-backend.js). Returns structured page info:
// {url, title, lang, viewport, interactive[], headings[]}.
//
// This file is read as TEXT (not require'd) — it is the expression
// itself, not a module. Keeping it standalone guarantees both backends
// produce identical output regardless of who's driving.
//
// Selector synthesis priority (per element):
//   1. `#id`              if the id is a clean identifier
//   2. `tag[name='x']`    for form fields and named buttons
//   3. `[data-testid='']` if present
//   4. `tag[aria-label='']` if short enough to be useful
//   5. tag + nth-of-type path (last 4 levels) — fallback
//
// Sorting: in-viewport elements first, then visible, then off-screen.
// Truncated to top 80 / 40 to keep tool response under token budget.

(() => {
  function _esc(s) { return String(s).replace(/'/g, "\\'"); }
  function selectorFor(el) {
    if (!el) return null;
    if (el.id && /^[\w:-]+$/.test(el.id)) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    if (el.name && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button')) {
      return tag + "[name='" + _esc(el.name) + "']";
    }
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testid) return "[data-testid='" + _esc(testid) + "']";
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80) return tag + "[aria-label='" + _esc(aria) + "']";
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.tagName && depth < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.parentElement) {
        const sibs = Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }
  function rectVis(el) {
    if (!el || !el.getBoundingClientRect) return { visible: false, in_viewport: false };
    const r = el.getBoundingClientRect();
    const visible = el.offsetParent !== null && r.width > 0 && r.height > 0;
    const in_viewport = visible && r.bottom > 0 && r.top < (window.innerHeight || 720);
    return { visible, in_viewport, top: Math.round(r.top), left: Math.round(r.left) };
  }
  function trim(s, n) { return (s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

  const interactiveSel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=switch], [contenteditable=true]';
  const interactive = [];
  const seen = new WeakSet();
  for (const el of document.querySelectorAll(interactiveSel)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const kind = role || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag);
    const v = rectVis(el);
    const item = {
      kind,
      selector: selectorFor(el),
      visible: v.visible,
      in_viewport: v.in_viewport,
    };
    if (tag === 'a') item.href = el.href || null;
    if (tag === 'input' || tag === 'textarea') {
      item.type = el.type || 'text';
      if (el.name) item.name = el.name;
      if (el.value) item.value = String(el.value).slice(0, 200);
      if (el.placeholder) item.placeholder = el.placeholder;
      if (el.required) item.required = true;
      if (el.disabled) item.disabled = true;
    }
    if (tag === 'select') {
      if (el.name) item.name = el.name;
      item.options = Array.from(el.options).slice(0, 20).map(o => ({
        value: o.value, label: trim(o.label || o.text, 80), selected: o.selected
      }));
    }
    if (tag === 'button' && el.disabled) item.disabled = true;
    const text = trim(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '', 120);
    if (text) item.text = text;
    interactive.push(item);
  }
  interactive.sort((a, b) => {
    if (a.in_viewport !== b.in_viewport) return a.in_viewport ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return 0;
  });
  const totalInteractive = interactive.length;

  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
    level: parseInt(h.tagName[1]),
    text: trim(h.innerText, 200),
    selector: selectorFor(h),
  })).filter(h => h.text);

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: Math.round(window.scrollY) },
    interactive: interactive.slice(0, 80),
    interactive_total: totalInteractive,
    headings: headings.slice(0, 40),
  };
})()
