// mobile-shell.js — wires the mobile-viewer.html chrome (#m-header,
// #m-tab-bar, #m-drawer) and moves the desktop chat DOM into the mobile
// chat surface. Loaded ONLY by mobile-viewer.html, AFTER boot.js.
//
// Phase N1 strategy:
//   - Chat: move #chat-messages and #chat-input-area into #m-chat-view
//     so chat.js's WS-driven rendering populates the mobile bubbles
//     (CSS in mobile-shell.css restyles .chat-msg / .chat-row from
//     desktop layout into iMessage-style bubbles).
//   - Graph + Settings: tab views show "coming in N2/N3" placeholders;
//     the desktop graph canvas and settings modal stay hidden.
//   - Drawer (☰): theme toggle, multi-graph picker (reuses tools-menu),
//     desktop-view escape hatch.
//
// Phase N2 + N3 will replace the placeholders with their own
// mobile-native surfaces (graph node list, settings drilldown).

(function initMobileShell() {
  const body = document.body;
  const tabs = document.querySelectorAll('#m-tab-bar button[data-m-view]');
  if (!tabs.length) return; // not mobile shell — bail

  // ── Suppress desktop right-panel auto-restore ──
  // panels.js#restorePanelState reopens whichever pane the user last
  // had open via openRightPanel(). On the mobile shell we never want
  // that; clear floatingTabs / activeRpTab from localStorage before
  // boot.js's await yields back to showApp() → initApp().
  try {
    const STATE_KEY = '_panelState';
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    if ((s.floatingTabs && s.floatingTabs.length) || s.activeRpTab) {
      delete s.floatingTabs;
      delete s.activeRpTab;
      localStorage.setItem(STATE_KEY, JSON.stringify(s));
    }
  } catch {}
  document.getElementById('right-panel')?.classList.add('closed');

  // ── Move the chat DOM into the mobile chat surface ──
  // chat.js's #chat-messages + #chat-input-area carry every message
  // bubble and the composer controls. We move them into our mobile
  // shell so chat.js keeps writing to those nodes and our CSS restyles
  // them as mobile-native bubbles + composer. The original #chat-panel
  // is hidden via mobile-shell.css.
  const chatStream = document.getElementById('m-chat-stream');
  const composer = document.getElementById('m-composer');
  const chatMessages = document.getElementById('chat-messages');
  const chatInputArea = document.getElementById('chat-input-area');
  const subagent = document.getElementById('subagent-container');
  const activity = document.getElementById('agent-activity');
  if (chatStream && chatMessages) chatStream.appendChild(chatMessages);
  if (chatStream && subagent) chatStream.appendChild(subagent);
  if (chatStream && activity) chatStream.appendChild(activity);
  if (composer && chatInputArea) composer.appendChild(chatInputArea);

  // ── Tab bar ──
  function setView(view) {
    body.classList.remove('m-view-chat', 'm-view-graph', 'm-view-settings');
    body.classList.add('m-view-' + view);
    tabs.forEach(t => t.classList.toggle('active', t.dataset.mView === view));
    const title = document.getElementById('m-title');
    if (title) {
      title.textContent = view === 'chat' ? 'spore'
        : view === 'graph' ? 'graph'
        : 'settings';
    }
  }
  tabs.forEach(t => t.addEventListener('click', () => setView(t.dataset.mView)));
  setView('chat');

  // ── Header theme toggle ──
  document.getElementById('m-theme-btn')?.addEventListener('click', () => {
    if (typeof window.toggleTheme === 'function') window.toggleTheme();
    syncThemeIcon();
  });
  function syncThemeIcon() {
    try {
      const t = localStorage.getItem('spore-theme') || 'dark';
      const btn = document.getElementById('m-theme-btn');
      if (btn) btn.textContent = t === 'light' ? '☀' : '🌙';
    } catch {}
  }
  syncThemeIcon();
  setTimeout(syncThemeIcon, 1500);

  // ── Composer: Enter sends, Shift+Enter newline ──
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const sendBtn = document.getElementById('chat-send');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
  });

  // ── Auto-scroll: keep stream pinned to bottom on new content ──
  // chat.js does its own scroll, but it reads the desktop container's
  // scroll position. Now that #chat-messages lives inside #m-chat-stream
  // we need to scroll the stream container instead.
  if (chatStream && chatMessages) {
    const mo = new MutationObserver(() => {
      const nearBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80;
      if (nearBottom) chatStream.scrollTop = chatStream.scrollHeight;
    });
    mo.observe(chatMessages, { childList: true, subtree: true, characterData: true });
  }

  // ── Mobile graph view ──
  initMobileGraphView();
})();

function initMobileGraphView() {
  // Move desktop pieces into the mobile graph layout.
  const canvasSlot = document.getElementById('m-g-canvas-slot');
  const desktopCanvas = document.getElementById('canvas');
  if (canvasSlot && desktopCanvas) canvasSlot.appendChild(desktopCanvas);

  const detailBody = document.getElementById('m-g-detail-body');
  const panelBody = document.getElementById('panel-body');
  if (detailBody && panelBody) detailBody.appendChild(panelBody);

  // Move the desktop view-mode-bar buttons into our mode-row so the
  // existing extras.js click handlers (data-vm) still fire — same
  // event bindings, new chrome.
  const modeRow = document.getElementById('m-g-mode-row');
  const desktopVmBar = document.getElementById('view-mode-bar');
  if (modeRow && desktopVmBar) {
    desktopVmBar.querySelectorAll('button[data-vm]').forEach(b => modeRow.appendChild(b));
  }

  // d3 measured itself when #m-graph-view was display:none → its box
  // was zero. On first graph-tab activation, fire window.resize so
  // graph.js refits via its tick handler.
  let firstGraphActivation = true;
  const bodyObserver = new MutationObserver(() => {
    if (document.body.classList.contains('m-view-graph') && firstGraphActivation) {
      firstGraphActivation = false;
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
  });
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ── Create-button submenu ──
  // Items vary by active view-mode. Currently only the 'graph' mode
  // has actionable creators (new node) — others get a soft message.
  const createBtn = document.getElementById('m-g-create-btn');
  const createMenu = document.getElementById('m-g-create-menu');
  function activeMode() {
    const active = document.querySelector('#m-g-mode-row button.active');
    return active?.dataset.vm || 'graph';
  }
  function buildCreateMenu() {
    if (!createMenu) return;
    const mode = activeMode();
    const items = [];
    if (mode === 'graph' || mode === 'list') {
      items.push({ label: '+ node', action: () => window.showNewNodeModal?.() });
    }
    if (mode === 'work') {
      items.push({ label: '+ person', action: () => window.showNewNodeModal?.('person') });
      items.push({ label: '+ project', action: () => window.showNewNodeModal?.('project') });
    }
    if (mode === 'typemap') {
      items.push({ label: '+ node', action: () => window.showNewNodeModal?.() });
    }
    createMenu.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'm-g-create-item';
      empty.style.opacity = '0.6';
      empty.textContent = 'no actions in this mode';
      createMenu.appendChild(empty);
      return;
    }
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-g-create-item';
      b.textContent = it.label;
      b.addEventListener('click', () => { closeCreateMenu(); try { it.action(); } catch {} });
      createMenu.appendChild(b);
    }
  }
  function openCreateMenu() {
    buildCreateMenu();
    createMenu?.classList.add('open');
    createBtn?.setAttribute('aria-expanded', 'true');
  }
  function closeCreateMenu() {
    createMenu?.classList.remove('open');
    createBtn?.setAttribute('aria-expanded', 'false');
  }
  createBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (createMenu?.classList.contains('open')) closeCreateMenu();
    else openCreateMenu();
  });
  document.addEventListener('click', (e) => {
    if (!createMenu?.contains(e.target) && e.target !== createBtn) closeCreateMenu();
  });
  // Rebuild items whenever the mode changes (handles desktop's
  // delegate-toggle on data-vm buttons).
  if (modeRow) {
    new MutationObserver(buildCreateMenu).observe(modeRow, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  // ── Search input ──
  // Wire to the desktop's #search-input (inside #search) so the
  // existing graph.js search highlighting + filter logic fires.
  const mSearchEl = document.getElementById('m-g-search-input');
  const desktopSearchEl = document.getElementById('search-input');
  if (mSearchEl) {
    mSearchEl.addEventListener('input', () => {
      if (!desktopSearchEl) return;
      desktopSearchEl.value = mSearchEl.value;
      desktopSearchEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // ── Bottom detail panel ──
  const detail = document.getElementById('m-g-detail');
  const detailHandle = document.getElementById('m-g-detail-handle');
  const detailClose = document.getElementById('m-g-detail-close');
  const summaryLabel = document.getElementById('m-g-detail-summary-label');

  function setDetail(open) {
    if (!detail) return;
    detail.classList.toggle('open', !!open);
    detail.classList.toggle('collapsed', !open);
    if (detailClose) detailClose.hidden = !open;
  }
  setDetail(false);

  detailHandle?.addEventListener('click', (e) => {
    if (e.target === detailClose) return;
    setDetail(detail.classList.contains('collapsed'));
  });
  detailClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    setDetail(false);
    // Clear desktop selection so the editor body empties out.
    if (typeof window.clearGraphSelection === 'function') window.clearGraphSelection();
  });

  // Auto-open when a node gets selected. graph.js mutates
  // #panel-body whenever selectNode runs; observing it lets us hook
  // selection without modifying graph.js.
  if (panelBody && detail) {
    const mo = new MutationObserver(() => {
      const hasNode = !!panelBody.firstElementChild;
      // Pull a label out of the editor markup if present.
      if (hasNode) {
        const labelInput = panelBody.querySelector('#edit-label, [data-edit-label], input[name="label"]');
        const idText = panelBody.querySelector('#edit-id')?.value || '';
        const lbl = (labelInput && (labelInput.value || labelInput.textContent)) || idText || 'node';
        if (summaryLabel) summaryLabel.textContent = lbl;
        setDetail(true);
      } else {
        if (summaryLabel) summaryLabel.textContent = 'tap a node to see details';
        setDetail(false);
      }
    });
    mo.observe(panelBody, { childList: true, subtree: false });
  }
}
