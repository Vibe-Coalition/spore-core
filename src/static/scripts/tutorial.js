// tutorial.js - Role-aware first-run product tour for the web app.

const APP_TOUR_VERSION = 3;
let _appTourState = null;
let _appTourBootChecked = false;

function _tourRoleKey(role = _userRole) {
  return (role === 'creator' || role === 'admin') ? 'admin' : 'user';
}

function _tourStorageKey(roleKey) {
  const user = String(_currentUserName || 'default').toLowerCase();
  return `spore-app-tour:${APP_TOUR_VERSION}:${roleKey}:${user}`;
}

function _tourIsUsableTarget(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function _tourFindGraphNode(match = {}) {
  const nodes = Array.from(document.querySelectorAll('#graph-svg .graph-node'));
  if (!nodes.length) return null;
  const norm = (value) => String(value || '').trim().toLowerCase();
  const wantsId = norm(match.id);
  const wantsType = norm(match.type);
  const wantsPrefix = norm(match.idPrefix);
  const wantsLabel = norm(match.labelIncludes);
  const scored = [];

  for (const el of nodes) {
    const data = el.__data__ || {};
    const id = norm(data.id || el.dataset.nodeId);
    const type = norm(data.type || el.dataset.nodeType);
    const label = norm(data.label || data.name || '');
    let score = 0;
    if (wantsId && id === wantsId) score += 100;
    if (wantsType && type === wantsType) score += 30;
    if (wantsPrefix && id.startsWith(wantsPrefix)) score += 20;
    if (wantsLabel && label.includes(wantsLabel)) score += 10;
    if (!wantsId && !wantsType && !wantsPrefix && !wantsLabel) score = 1;
    if (score > 0) scored.push({ el, score, id });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored[0]?.el || null;
}

function _tourSteps(roleKey) {
  const baseIntro = [
    {
      target: '#chat-panel',
      title: 'Chat',
      body: 'This is the main conversation surface. Send text, attach files, use voice, and stop a response while the agent is working.',
      placement: 'left',
    },
    {
      target: '#canvas',
      title: 'Knowledge Graph',
      body: 'This canvas shows the agent memory graph. Select nodes to inspect what the agent knows and how memories connect.',
      placement: 'right',
    },
    {
      node: { id: 'spore', type: 'self' },
      title: 'Spore Node',
      body: 'This is the agent self node. It anchors identity, core behavior, and operating context for the current graph.',
      placement: 'right',
    },
    {
      node: { type: 'reference', idPrefix: 'ref-' },
      title: 'Reference Nodes',
      body: 'Reference nodes are built-in instructions and operating notes. They help the agent understand the rules for this graph mode.',
      placement: 'right',
    },
    {
      target: '#view-mode-bar',
      title: 'Views',
      body: 'Switch between graph, list, type map, and people/project views. The theme toggle also lives here.',
      placement: 'bottom',
    },
    {
      target: '#desktop-dock',
      title: 'Dock',
      body: 'The dock opens the main work surfaces without changing the current graph view.',
      placement: 'top',
    },
  ];

  const commonDockButtons = [
    {
      target: '#dock-graphs',
      title: 'Graph Switcher',
      body: roleKey === 'admin'
        ? 'Jump between managed graphs such as default memory, general knowledge, projects, channels, and users.'
        : 'View the graphs you can access, including default knowledge, general knowledge, your user graph, and project graphs shared with you.',
      placement: 'top',
    },
    {
      target: '#dock-node',
      title: 'Node Window',
      body: 'Open the node inspector. It shows details, aspects, attributes, and links for the selected memory node.',
      placement: 'top',
    },
  ];

  const commonTail = [
    {
      target: '#dock-settings',
      title: 'Settings',
      body: roleKey === 'admin'
        ? 'Configure providers, plugins, channels, backups, users, graph maintenance, and runtime settings.'
        : 'Update your profile, display name, password, and personal app preferences.',
      placement: 'top',
    },
    {
      target: '#event-log',
      title: 'Live Activity',
      body: 'This compact log shows graph updates and background activity as they happen.',
      placement: 'top',
    },
    {
      center: true,
      title: 'Have Fun',
      body: 'You are ready to go. Explore the graph, ask the agent for help, and let the memory grow as you work.',
    },
  ];

  if (roleKey !== 'admin') return [...baseIntro, ...commonDockButtons, ...commonTail];
  return [
    ...baseIntro,
    ...commonDockButtons,
    {
      target: '#dock-files',
      title: 'Files',
      body: 'Browse the workspace, upload files, mount local folders, and inspect files the agent works with.',
      placement: 'top',
    },
    {
      target: '#dock-logs',
      title: 'Logs',
      body: 'Open runtime logs when you need to debug providers, tools, channels, or background jobs.',
      placement: 'top',
    },
    {
      target: '#dock-terminal',
      title: 'Terminal',
      body: 'Open a shell for operator work. Normal web users do not get this surface.',
      placement: 'top',
    },
    ...commonTail,
  ];
}

function _buildTourDom() {
  const overlay = document.createElement('div');
  overlay.id = 'app-tour-overlay';
  overlay.className = 'app-tour-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'App tour');
  overlay.innerHTML = `
    <div class="app-tour-highlight" aria-hidden="true"></div>
    <div class="app-tour-card" role="document">
      <div class="app-tour-kicker"></div>
      <h3 class="app-tour-title"></h3>
      <p class="app-tour-body"></p>
      <div class="app-tour-foot">
        <button type="button" class="app-tour-btn ghost" data-tour-action="skip">Skip tour</button>
        <span class="app-tour-count"></span>
        <button type="button" class="app-tour-btn" data-tour-action="back">Back</button>
        <button type="button" class="app-tour-btn primary" data-tour-action="next">Next</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function _tourTargetRect(step) {
  if (step.center) return { el: null, rect: null };
  const el = step.node ? _tourFindGraphNode(step.node) : document.querySelector(step.target);
  if (!_tourIsUsableTarget(el)) return null;
  return { el, rect: el.getBoundingClientRect() };
}

function _clearTourNodeHighlights() {
  document.querySelectorAll('.app-tour-node-target').forEach(el => el.classList.remove('app-tour-node-target'));
}

function _placeTourCard(card, rect, placement) {
  const gap = 14;
  const margin = 14;
  const cardRect = card.getBoundingClientRect();
  let left = margin;
  let top = margin;

  if (!rect) {
    left = (window.innerWidth - cardRect.width) / 2;
    top = (window.innerHeight - cardRect.height) / 2;
  } else if (placement === 'left') {
    left = rect.left - cardRect.width - gap;
    top = rect.top + (rect.height - cardRect.height) / 2;
    if (left < margin) left = rect.right + gap;
  } else if (placement === 'right') {
    left = rect.right + gap;
    top = rect.top + (rect.height - cardRect.height) / 2;
    if (left + cardRect.width > window.innerWidth - margin) left = rect.left - cardRect.width - gap;
  } else if (placement === 'bottom') {
    left = rect.left + (rect.width - cardRect.width) / 2;
    top = rect.bottom + gap;
    if (top + cardRect.height > window.innerHeight - margin) top = rect.top - cardRect.height - gap;
  } else {
    left = rect.left + (rect.width - cardRect.width) / 2;
    top = rect.top - cardRect.height - gap;
    if (top < margin) top = rect.bottom + gap;
  }

  left = Math.max(margin, Math.min(left, window.innerWidth - cardRect.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - cardRect.height - margin));
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function _visibleTourSteps(roleKey) {
  return _tourSteps(roleKey).filter(step => _tourTargetRect(step));
}

function _renderTourStep() {
  if (!_appTourState) return;
  const { overlay, steps, index } = _appTourState;
  const step = steps[index];
  const target = _tourTargetRect(step);
  const highlight = overlay.querySelector('.app-tour-highlight');
  const card = overlay.querySelector('.app-tour-card');
  _clearTourNodeHighlights();
  if (target?.el?.classList?.contains('graph-node')) target.el.classList.add('app-tour-node-target');

  overlay.querySelector('.app-tour-kicker').textContent = _appTourState.roleKey === 'admin' ? 'Admin tour' : 'User tour';
  overlay.querySelector('.app-tour-title').textContent = step.title;
  overlay.querySelector('.app-tour-body').textContent = step.body;
  overlay.querySelector('.app-tour-count').textContent = `${index + 1} / ${steps.length}`;
  overlay.querySelector('[data-tour-action="back"]').disabled = index === 0;
  overlay.querySelector('[data-tour-action="next"]').textContent = index === steps.length - 1 ? 'Finish' : 'Next';

  if (target) {
    const pad = 8;
    highlight.classList.remove('centered');
    highlight.style.left = `${Math.max(8, target.rect.left - pad)}px`;
    highlight.style.top = `${Math.max(8, target.rect.top - pad)}px`;
    highlight.style.width = `${Math.max(20, target.rect.width + pad * 2)}px`;
    highlight.style.height = `${Math.max(20, target.rect.height + pad * 2)}px`;
  } else {
    highlight.classList.add('centered');
    highlight.style.left = '50%';
    highlight.style.top = '50%';
    highlight.style.width = '1px';
    highlight.style.height = '1px';
  }

  requestAnimationFrame(() => _placeTourCard(card, target?.rect || null, step.placement));
}

function _markTourSeen(roleKey) {
  try { localStorage.setItem(_tourStorageKey(roleKey), '1'); } catch {}
  fetch(API + '/api/preferences', {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tutorialSeen: { [roleKey]: true },
      tutorialVersion: { [roleKey]: APP_TOUR_VERSION },
    }),
  }).catch(() => {});
}

function closeAppTour(markSeen = false) {
  if (!_appTourState) return;
  const state = _appTourState;
  window.removeEventListener('resize', _renderTourStep);
  window.removeEventListener('keydown', _handleTourKeydown);
  _clearTourNodeHighlights();
  state.overlay.remove();
  _appTourState = null;
  if (markSeen) _markTourSeen(state.roleKey);
}

function _advanceTour(delta) {
  if (!_appTourState) return;
  const next = _appTourState.index + delta;
  if (next < 0) return;
  if (next >= _appTourState.steps.length) {
    closeAppTour(true);
    return;
  }
  _appTourState.index = next;
  _renderTourStep();
}

function _handleTourKeydown(e) {
  if (!_appTourState) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAppTour(true);
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    e.preventDefault();
    _advanceTour(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    _advanceTour(-1);
  }
}

function startAppTour(opts = {}) {
  const roleKey = opts.roleKey || _tourRoleKey(opts.role);
  const steps = _visibleTourSteps(roleKey);
  if (!steps.length) {
    if (!opts.manual) _markTourSeen(roleKey);
    return;
  }
  closeAppTour(false);
  const overlay = _buildTourDom();
  _appTourState = { overlay, roleKey, steps, index: 0, manual: !!opts.manual };
  overlay.addEventListener('click', (e) => {
    const action = e.target?.dataset?.tourAction;
    if (action === 'skip') closeAppTour(true);
    else if (action === 'back') _advanceTour(-1);
    else if (action === 'next') _advanceTour(1);
  });
  window.addEventListener('resize', _renderTourStep);
  window.addEventListener('keydown', _handleTourKeydown);
  _renderTourStep();
}

async function maybeStartFirstRunTour() {
  if (_appTourBootChecked) return;
  _appTourBootChecked = true;
  window.setTimeout(async () => {
    const roleKey = _tourRoleKey();
    let seen = false;
    try { seen = localStorage.getItem(_tourStorageKey(roleKey)) === '1'; } catch {}
    try {
      const r = await fetch(API + '/api/preferences', { headers: authHeaders() });
      const data = await r.json();
      const seenVersion = Number(data?.tutorialVersion?.[roleKey] || 0);
      if (data?.tutorialSeen?.[roleKey] === true && seenVersion >= APP_TOUR_VERSION) seen = true;
    } catch {}
    if (!seen) startAppTour({ roleKey });
  }, 900);
}

document.getElementById('tmi-tour')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.getElementById('tools-menu');
  if (menu) menu.style.display = 'none';
  try { _toolsMenuOpen = false; } catch {}
  startAppTour({ manual: true });
});

window.startAppTour = startAppTour;
window.maybeStartFirstRunTour = maybeStartFirstRunTour;
