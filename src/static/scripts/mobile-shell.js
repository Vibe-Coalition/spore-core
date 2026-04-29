// mobile-shell.js — wires the mobile-viewer.html chrome (#m-header,
// #m-tab-bar, #m-drawer) to the existing desktop module APIs. Loaded
// ONLY by mobile-viewer.html, AFTER boot.js so every other module is
// in scope.
//
// Tab switching is class-driven on <body>:
//   .m-view-chat      — show #chat-panel (default)
//   .m-view-graph     — show #canvas (graph)
//   .m-view-settings  — show #settings-pane as a full-screen sheet
//
// Drawer is also class-driven:
//   .m-drawer-open    — slide #m-drawer in from left, scrim active

(function initMobileShell() {
  const body = document.body;
  const tabs = document.querySelectorAll('#m-tab-bar button[data-m-view]');
  if (!tabs.length) return; // not mobile shell — bail

  // ── Tab bar ──
  function setView(view) {
    body.classList.remove('m-view-chat', 'm-view-graph', 'm-view-settings');
    body.classList.add('m-view-' + view);
    tabs.forEach(t => t.classList.toggle('active', t.dataset.mView === view));
    if (view === 'settings' && typeof window.openSettingsPanel === 'function') {
      window.openSettingsPanel();
    } else if (view !== 'settings') {
      // closing settings — clear .open so it stays hidden until next time
      document.getElementById('settings-pane')?.classList.remove('open');
    }
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

  // Drawer rows
  document.getElementById('m-drawer-theme')?.addEventListener('click', () => {
    if (typeof window.toggleTheme === 'function') window.toggleTheme();
    syncThemeIcon();
  });
  document.getElementById('m-drawer-graphs')?.addEventListener('click', () => {
    closeDrawer();
    // The desktop multi-graph picker is wired to #tmi-graphs in tools-menu;
    // the cleanest reuse is to programmatically open it.
    document.getElementById('tmi-graphs')?.click();
  });

  // ── Header theme button mirrors the drawer theme toggle ──
  document.getElementById('m-theme-btn')?.addEventListener('click', () => {
    if (typeof window.toggleTheme === 'function') window.toggleTheme();
    syncThemeIcon();
  });

  function syncThemeIcon() {
    // applyGraphTheme stores the resolved name in localStorage('spore-theme').
    // Header icon flips: dark → 🌙, light → ☀.
    try {
      const t = localStorage.getItem('spore-theme') || 'dark';
      const btn = document.getElementById('m-theme-btn');
      if (btn) btn.textContent = t === 'light' ? '☀' : '🌙';
    } catch {}
  }
  syncThemeIcon();
  // Sync once after defer scripts settle (loadGraphThemePreference resolves
  // the server preference late and may flip the saved theme).
  setTimeout(syncThemeIcon, 1500);

  // ── Chat input: Enter sends, Shift+Enter newline ──
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const sendBtn = document.getElementById('chat-send');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
  });

  // ── Node viewer as bottom sheet ──
  // Desktop opens #right-panel by removing .closed and adding
  // .window-open/.active to the target pane. On mobile, the CSS turns
  // that into a slide-up sheet. We just need a swipe-down to close.
  const rp = document.getElementById('right-panel');
  if (rp) {
    let touchStartY = null;
    rp.addEventListener('touchstart', (e) => {
      // Only start drag from the top ~30px (drag affordance area)
      const offset = e.touches[0].clientY - rp.getBoundingClientRect().top;
      if (offset > 30) return;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    rp.addEventListener('touchmove', (e) => {
      if (touchStartY == null) return;
      const dy = e.touches[0].clientY - touchStartY;
      if (dy > 0) rp.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    rp.addEventListener('touchend', (e) => {
      if (touchStartY == null) return;
      const dy = (e.changedTouches[0].clientY - touchStartY);
      rp.style.transform = '';
      if (dy > 100) {
        // Swiped down far enough → close. The desktop "close" path adds
        // .closed class and removes .window-open from panes.
        rp.classList.add('closed');
        document.querySelectorAll('.rp-pane.window-open, .rp-pane.active')
          .forEach(p => { p.classList.remove('window-open'); p.classList.remove('active'); });
      }
      touchStartY = null;
    }, { passive: true });
  }
})();
