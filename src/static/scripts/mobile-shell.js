// mobile-shell.js — wires the mobile-viewer.html chrome (#m-header,
// #m-tab-bar) to the existing desktop module APIs. Loaded ONLY by
// mobile-viewer.html, AFTER boot.js so every other module is in scope.
//
// Tab switching is class-driven on <body>:
//   .m-view-chat      — show #chat-panel (default)
//   .m-view-graph     — show #canvas (graph)
//   .m-view-settings  — show #settings-pane as a full-screen sheet
//
// CSS in mobile-shell.css watches these classes and reveals the right
// view. JS just toggles the class and (for settings) calls the
// existing openSettingsPanel() — same code path as the desktop tools
// menu.

(function initMobileShell() {
  const body = document.body;
  const tabs = document.querySelectorAll('#m-tab-bar button[data-m-view]');
  if (!tabs.length) return; // not mobile shell — bail

  function setView(view) {
    body.classList.remove('m-view-chat', 'm-view-graph', 'm-view-settings');
    body.classList.add('m-view-' + view);
    tabs.forEach(t => t.classList.toggle('active', t.dataset.mView === view));
    // Settings tab opens the existing pane modal; chat / graph are
    // pure CSS reveals.
    if (view === 'settings' && typeof window.openSettingsPanel === 'function') {
      window.openSettingsPanel();
    } else if (view !== 'settings') {
      const settings = document.getElementById('settings-pane');
      settings?.classList.remove('open');
    }
    // Header title reflects the active view.
    const title = document.getElementById('m-title');
    if (title) {
      title.textContent = view === 'chat' ? 'SPORE'
        : view === 'graph' ? 'Graph'
        : 'Settings';
    }
  }

  tabs.forEach(t => t.addEventListener('click', () => setView(t.dataset.mView)));

  // Default view = chat.
  setView('chat');

  // Header buttons
  document.getElementById('m-menu-btn')?.addEventListener('click', () => {
    // Future: slide-out drawer with sessions, multi-graph picker, etc.
    // For M1: nothing.
  });
  document.getElementById('m-settings-btn')?.addEventListener('click', () => setView('settings'));

  // The desktop chat-input enables the send button on input. On mobile
  // we want the same behavior — but the desktop wiring is already in
  // chat.js. Just defensively ensure send-on-Enter works (Enter sends,
  // Shift+Enter newline) — this matches desktop chat-input behavior.
  const chatInput = document.getElementById('chat-input');
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const sendBtn = document.getElementById('chat-send');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
  });

  // When the user taps the chat tab while the wizard is active, the
  // wizard overlay still covers the screen — that's fine, the wizard
  // is the gate to the rest of the UI. mobile-shell.css gives it
  // 100vh/100dvh so it dominates the viewport.
})();
