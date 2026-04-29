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
      title.textContent = view === 'chat' ? 'SPORE'
        : view === 'graph' ? 'Graph'
        : 'Settings';
    }
    closeDrawer();
  }
  tabs.forEach(t => t.addEventListener('click', () => setView(t.dataset.mView)));
  setView('chat');

  // ── Drawer ──
  function openDrawer() { body.classList.add('m-drawer-open'); }
  function closeDrawer() { body.classList.remove('m-drawer-open'); }

  document.getElementById('m-menu-btn')?.addEventListener('click', openDrawer);
  document.getElementById('m-drawer-close')?.addEventListener('click', closeDrawer);
  document.getElementById('m-drawer-scrim')?.addEventListener('click', closeDrawer);

  document.getElementById('m-drawer-theme')?.addEventListener('click', () => {
    if (typeof window.toggleTheme === 'function') window.toggleTheme();
    syncThemeIcon();
  });
  document.getElementById('m-drawer-graphs')?.addEventListener('click', () => {
    closeDrawer();
    document.getElementById('tmi-graphs')?.click();
  });

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
})();
