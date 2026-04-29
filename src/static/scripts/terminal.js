// terminal.js — Terminal pane (xterm.js + grid layout + SSH host management).
// Extracted from src/static/scripts/app.js (was lines 12978-13487 of the post-Phase-2 monolith).

// ── Terminal Pane (Grid Layout) ────────────────────────────────────────
(function initTerminal() {
  let xtermLoaded = false, xtermLoading = false;
  let terminalActive = false;
  const termPane = document.getElementById('terminal-pane');
  const terminalStatusEl = document.getElementById('terminal-window-status');
  const termPanesEl = document.getElementById('terminal-panes');
  const tabsContainer = document.getElementById('term-tabs-container');
  const hostSelect = document.getElementById('terminal-host-select');
  const layoutSelect = document.getElementById('term-layout-select');
  let termHeight = 300;
  let editingHostId = null;
  let paneCounter = 0;
  const panes = new Map();
  let paneOrder = [];
  let focusedPaneId = null;
  let currentLayout = '1';

  const LAYOUT_SLOTS = { '1': 1, '2col': 2, '3col': 3, '2row': 2, '3row': 3, '2x2': 4, '1l2r': 3 };

  const XTERM_OPTS = {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    theme: { background: '#16140f', foreground: '#ece4cf', cursor: '#e08a4e',
             selectionBackground: 'rgba(224,138,78,0.3)' },
    cursorBlink: true,
    scrollback: 5000,
  };

  function updateTerminalWindowStatus() {
    if (!terminalStatusEl) return;
    if (!panes.size) {
      terminalStatusEl.textContent = 'local shell';
      return;
    }
    const focused = focusedPaneId ? panes.get(focusedPaneId) : null;
    const label = focused?.label || 'local';
    const count = `${panes.size} pane${panes.size === 1 ? '' : 's'}`;
    terminalStatusEl.textContent = `${label} · ${count}`;
  }

  function loadXterm(cb) {
    if (xtermLoaded) return cb();
    if (xtermLoading) { setTimeout(() => loadXterm(cb), 100); return; }
    xtermLoading = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
    document.head.appendChild(link);
    const s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js';
      s2.onload = () => { xtermLoaded = true; cb(); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  }

  function genPaneId() { return 'p' + (++paneCounter); }

  function createPane(hostId) {
    const id = genPaneId();
    const host = hostId || hostSelect.value || 'local';
    const label = host === 'local' ? 'local' : (hostSelect.querySelector(`option[value="${host}"]`)?.textContent || host);

    const xterm = new window.Terminal(XTERM_OPTS);
    const fitAddon = new window.FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);

    const wrap = document.createElement('div');
    wrap.className = 'term-pane-wrap';
    wrap.dataset.paneId = id;

    const labelEl = document.createElement('div');
    labelEl.className = 'term-pane-label';
    labelEl.textContent = label;
    wrap.appendChild(labelEl);

    const body = document.createElement('div');
    body.className = 'term-pane-body';
    wrap.appendChild(body);

    xterm.open(body);

    wrap.addEventListener('mousedown', () => focusPane(id));
    xterm.onData((data) => {
      if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:data', paneId: id, data }));
    });
    xterm.onResize(({ cols, rows }) => {
      if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:resize', paneId: id, cols, rows }));
    });

    const pane = { id, xterm, fitAddon, wrap, body, label, hostId: host, labelEl };
    panes.set(id, pane);
    paneOrder.push(id);
    return pane;
  }

  function connectPane(id) {
    const p = panes.get(id);
    if (!p) return;
    const dims = p.fitAddon.proposeDimensions();
    if (window._ws?.readyState === 1) {
      window._ws.send(JSON.stringify({
        type: 'terminal:open', paneId: id, hostId: p.hostId,
        cols: dims?.cols || 80, rows: dims?.rows || 24,
      }));
    }
  }

  window._reconnectTerminals = function() {
    for (const [id, p] of panes) {
      p.xterm.write('\r\n\x1b[33m● Reconnecting...\x1b[0m\r\n');
      connectPane(id);
    }
  };

  function destroyPane(id) {
    const p = panes.get(id);
    if (!p) return;
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:close', paneId: id }));
    p.xterm.dispose();
    p.wrap.remove();
    panes.delete(id);
    paneOrder = paneOrder.filter(x => x !== id);
    if (focusedPaneId === id) {
      focusedPaneId = paneOrder[0] || null;
      if (focusedPaneId) focusPane(focusedPaneId);
    }
    updateTerminalWindowStatus();
  }

  function focusPane(id) {
    focusedPaneId = id;
    for (const [pid, p] of panes) p.wrap.classList.toggle('focused', pid === id);
    const p = panes.get(id);
    if (p) p.xterm.focus();
    renderTabs();
    updateTerminalWindowStatus();
  }

  function fitAll() {
    for (const [, p] of panes) { try { p.fitAddon.fit(); } catch {} }
  }
  window._refitTerminalLayout = fitAll;

  if (typeof ResizeObserver !== 'undefined') {
    const terminalResizeObserver = new ResizeObserver(() => {
      if (terminalActive) fitAll();
    });
    terminalResizeObserver.observe(termPane);
  }

  // ── Grid Layout ────────────────────────────────────────────────────

  function applyLayout(layout) {
    currentLayout = layout;
    layoutSelect.value = layout;
    const needed = LAYOUT_SLOTS[layout] || 1;

    while (paneOrder.length < needed) {
      const p = createPane();
      connectPane(p.id);
    }

    termPanesEl.className = 'layout-' + layout;
    termPanesEl.innerHTML = '';

    paneOrder.forEach(id => {
      const p = panes.get(id);
      if (p) termPanesEl.appendChild(p.wrap);
    });

    requestAnimationFrame(fitAll);
    if (!focusedPaneId && paneOrder.length) focusPane(paneOrder[0]);
    renderTabs();
    updateTerminalWindowStatus();
  }

  function bestLayout(count) {
    if (count <= 1) return '1';
    if (count === 2) return '2col';
    if (count === 3) return '1l2r';
    return '2x2';
  }

  // ── Tabs ───────────────────────────────────────────────────────────

  function renderTabs() {
    tabsContainer.innerHTML = '';
    for (const id of paneOrder) {
      const p = panes.get(id);
      if (!p) continue;
      const tab = document.createElement('div');
      tab.className = 'term-tab' + (id === focusedPaneId ? ' active' : '');
      tab.innerHTML = `<span>${esc(p.label)}</span><span class="tab-close" title="Close">&times;</span>`;
      tab.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closePane(id); });
      tab.addEventListener('click', () => focusPane(id));
      tabsContainer.appendChild(tab);
    }
  }

  function closePane(id) {
    destroyPane(id);
    if (panes.size === 0) { closeTerminal(); return; }
    applyLayout(bestLayout(paneOrder.length));
  }

  // ── Open / Close ───────────────────────────────────────────────────

  function openTerminal() {
    loadXterm(() => {
      termPane.classList.add('active', 'window-open');
      if (_usesFloatingWindows()) {
        _initFloatingWindow('terminal-pane', '.floating-pane-head');
        _applyFloatingWindowRect('terminal-pane');
      } else {
        termPane.style.height = termHeight + 'px';
      }
      terminalActive = true;
      document.getElementById('btn-terminal-header').classList.add('active');
      _focusFloatingWindow('terminal-pane');
      _updateFloatingWindowChrome('terminal-pane');

      if (panes.size === 0) {
        const p = createPane();
        applyLayout('1');
        connectPane(p.id);
        focusPane(p.id);
      } else {
        applyLayout(currentLayout);
      }
      updateTerminalWindowStatus();
      _savePanelState();
      if (typeof _syncUtilBar === 'function') _syncUtilBar();
    });
  }

  function addNewPane() {
    if (!terminalActive) { openTerminal(); return; }
    const p = createPane();
    connectPane(p.id);
    applyLayout(bestLayout(paneOrder.length));
    focusPane(p.id);
  }

  function closeTerminal() {
    for (const id of paneOrder) {
      if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:close', paneId: id }));
      panes.get(id)?.xterm?.dispose();
    }
    panes.clear();
    paneOrder = [];
    termPanesEl.innerHTML = '';
    tabsContainer.innerHTML = '';
    termPane.classList.remove('active', 'window-open', 'window-maximized');
    terminalActive = false;
    focusedPaneId = null;
    currentLayout = '1';
    layoutSelect.value = '1';
    document.getElementById('btn-terminal-header').classList.remove('active');
    delete termPane.dataset.prevRect;
    updateTerminalWindowStatus();
    _updateFloatingWindowChrome('terminal-pane');
    _savePanelState();
    if (typeof _syncUtilBar === 'function') _syncUtilBar();
  }

  // ── Event Bindings ─────────────────────────────────────────────────

  document.getElementById('btn-terminal-header').addEventListener('click', () => {
    if (terminalActive) closeTerminal(); else openTerminal();
  });
  document.getElementById('btn-term-add').addEventListener('click', addNewPane);
  layoutSelect.addEventListener('change', () => {
    if (!terminalActive) { openTerminal(); return; }
    applyLayout(layoutSelect.value);
  });
  document.getElementById('btn-terminal-close').addEventListener('click', closeTerminal);

  const resizeHandle = document.getElementById('terminal-resize-handle');
  let resizing = false, startY = 0, startH = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    resizing = true; startY = e.clientY; startH = termHeight;
    document.body.style.cursor = 'row-resize'; e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    if (_usesFloatingWindows()) return;
    const delta = startY - e.clientY;
    termHeight = Math.max(150, Math.min(800, startH + delta));
    termPane.style.height = termHeight + 'px';
    fitAll();
  });
  document.addEventListener('mouseup', () => {
    if (resizing) { resizing = false; document.body.style.cursor = ''; }
  });

  window.addEventListener('resize', () => { if (terminalActive) fitAll(); });

  // ── SSH Host Management ────────────────────────────────────────────

  document.getElementById('btn-terminal-hosts').addEventListener('click', () => {
    editingHostId = null;
    document.getElementById('ssh-form-title').textContent = 'Add Host';
    ['ssh-name','ssh-hostname','ssh-port','ssh-username','ssh-key','ssh-password'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('ssh-status').textContent = '';
    refreshHostList();
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:keystore:status' }));
    document.getElementById('ssh-modal-overlay').classList.add('active');
  });

  document.getElementById('btn-keystore-unlock').addEventListener('click', () => {
    const pass = document.getElementById('ssh-keystore-pass').value;
    if (!pass || pass.length < 8) { document.getElementById('ssh-keystore-pass').style.borderColor = '#e74c3c'; return; }
    document.getElementById('ssh-keystore-pass').style.borderColor = '';
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:keystore:unlock', passphrase: pass }));
  });

  document.getElementById('btn-keystore-lock').addEventListener('click', () => {
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:keystore:lock' }));
  });

  function updateKeystoreUI(unlocked, source) {
    const lockedEl = document.getElementById('ssh-keystore-locked');
    const unlockedEl = document.getElementById('ssh-keystore-unlocked');
    const formEl = document.getElementById('ssh-host-form');
    if (unlocked) {
      lockedEl.style.display = 'none';
      unlockedEl.style.display = '';
      formEl.style.display = '';
      const srcEl = document.getElementById('ssh-keystore-source');
      srcEl.textContent = source === 'webAuthPass' ? '(via login password)' : '(via session passphrase)';
      document.getElementById('btn-keystore-lock').style.display = source === 'webAuthPass' ? 'none' : '';
      document.getElementById('ssh-keystore-pass').value = '';
    } else {
      lockedEl.style.display = '';
      unlockedEl.style.display = 'none';
      formEl.style.display = 'none';
    }
  }

  document.getElementById('btn-ssh-save').addEventListener('click', () => {
    const msg = {
      type: 'terminal:hosts:save',
      id: editingHostId || 'host_' + Date.now(),
      name: document.getElementById('ssh-name').value,
      hostname: document.getElementById('ssh-hostname').value,
      port: parseInt(document.getElementById('ssh-port').value) || 22,
      username: document.getElementById('ssh-username').value,
    };
    const key = document.getElementById('ssh-key').value.trim();
    const pw = document.getElementById('ssh-password').value;
    if (key) msg.privateKey = key;
    if (pw) msg.password = pw;
    if (!msg.hostname || !msg.username) {
      document.getElementById('ssh-status').textContent = 'Hostname and username are required';
      return;
    }
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify(msg));
    document.getElementById('ssh-status').textContent = 'Saving...';
  });

  document.getElementById('btn-ssh-test').addEventListener('click', () => {
    const id = editingHostId;
    if (!id) { document.getElementById('ssh-status').textContent = 'Save the host first, then test'; return; }
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:hosts:test', id }));
    document.getElementById('ssh-status').textContent = 'Testing connection...';
  });

  function refreshHostList() {
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:hosts:list' }));
  }

  function renderHostList(hosts) {
    const container = document.getElementById('ssh-host-list');
    const select = document.getElementById('terminal-host-select');
    select.innerHTML = '<option value="local">local</option>';
    if (!hosts || hosts.length === 0) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:0.65rem">No SSH hosts configured</div>';
      return;
    }
    container.innerHTML = hosts.map(h => `
      <div class="ssh-host-item" data-id="${h.id}">
        <span class="host-info">${h.name} <span style="color:var(--text-dim)">(${h.username}@${h.hostname}:${h.port})</span></span>
        <span class="host-actions">
          <button onclick="editSSHHost('${h.id}')">edit</button>
          <button class="delete" onclick="deleteSSHHost('${h.id}')">del</button>
        </span>
      </div>
    `).join('');
    hosts.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.id; opt.textContent = h.name;
      select.appendChild(opt);
    });
  }

  window.editSSHHost = function(id) {
    editingHostId = id;
    document.getElementById('ssh-form-title').textContent = 'Edit Host';
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:hosts:list' }));
  };

  window.deleteSSHHost = function(id) {
    if (window._ws?.readyState === 1) window._ws.send(JSON.stringify({ type: 'terminal:hosts:delete', id }));
    setTimeout(refreshHostList, 200);
  };

  // ── Terminal WebSocket Messages ────────────────────────────────────

  const origOnMessage = window._onWsMessage;
  window._onWsMessage = function(msg) {
    const paneId = msg.paneId;
    if (msg.type === 'terminal:data' && paneId) {
      const p = panes.get(paneId);
      if (p) p.xterm.write(msg.data);
      return true;
    }
    if (msg.type === 'terminal:opened' && paneId) {
      const p = panes.get(paneId);
      const mode = msg.mode === 'ssh' ? `SSH` : 'local';
      if (p) {
        p.label = mode === 'SSH' ? (hostSelect.querySelector(`option[value="${msg.hostId}"]`)?.textContent || msg.hostId) : 'local';
        p.labelEl.textContent = p.label;
        p.xterm.write(`\x1b[32m● Connected: ${mode}\x1b[0m\r\n`);
        renderTabs();
        updateTerminalWindowStatus();
      }
      return true;
    }
    if (msg.type === 'terminal:closed' && paneId) {
      const p = panes.get(paneId);
      if (p) p.xterm.write(`\r\n\x1b[33m● ${msg.reason || 'Disconnected'}\x1b[0m\r\n`);
      return true;
    }
    if (msg.type === 'terminal:error' && paneId) {
      const p = panes.get(paneId);
      if (p) p.xterm.write(`\r\n\x1b[31m✗ ${msg.error}\x1b[0m\r\n`);
      return true;
    }
    if (msg.type === 'terminal:hosts') {
      renderHostList(msg.hosts);
      if (typeof fpPopulateHosts === 'function') fpPopulateHosts(msg.hosts || []);
      if (editingHostId && msg.hosts) {
        const h = msg.hosts.find(x => x.id === editingHostId);
        if (h) {
          document.getElementById('ssh-name').value = h.name || '';
          document.getElementById('ssh-hostname').value = h.hostname || '';
          document.getElementById('ssh-port').value = h.port || 22;
          document.getElementById('ssh-username').value = h.username || '';
        }
      }
      return true;
    }
    if (msg.type === 'terminal:hosts:saved') {
      if (msg.error) {
        document.getElementById('ssh-status').textContent = `✗ ${msg.error}`;
        document.getElementById('ssh-status').style.color = '#e74c3c';
      } else {
        document.getElementById('ssh-status').textContent = `Saved: ${msg.name}`;
        document.getElementById('ssh-status').style.color = '';
        editingHostId = msg.id;
        refreshHostList();
      }
      return true;
    }
    if (msg.type === 'terminal:hosts:deleted') { refreshHostList(); return true; }
    if (msg.type === 'terminal:hosts:tested') {
      document.getElementById('ssh-status').textContent = msg.success ? `✓ ${msg.message}` : `✗ ${msg.error}`;
      document.getElementById('ssh-status').style.color = msg.success ? '#4caf50' : '#e74c3c';
      setTimeout(() => { document.getElementById('ssh-status').style.color = ''; }, 3000);
      return true;
    }
    if (msg.type === 'terminal:keystore:status') {
      updateKeystoreUI(msg.unlocked, msg.source);
      return true;
    }
    if (msg.type === 'terminal:keystore:unlocked') {
      if (msg.success) {
        updateKeystoreUI(true, 'ui-passphrase');
        refreshHostList();
      } else {
        const passEl = document.getElementById('ssh-keystore-pass');
        passEl.style.borderColor = '#e74c3c';
        passEl.setCustomValidity(msg.error || 'Failed to unlock');
        const lockedEl = document.getElementById('ssh-keystore-locked');
        const errDiv = lockedEl.querySelector('.keystore-error');
        if (errDiv) errDiv.remove();
        const d = document.createElement('div');
        d.className = 'keystore-error';
        d.style.cssText = 'color:#e74c3c;font-size:0.6rem;margin-top:4px';
        d.textContent = msg.error || 'Failed to unlock';
        lockedEl.appendChild(d);
      }
      return true;
    }
    if (origOnMessage) return origOnMessage(msg);
    return false;
  };

  window.toggleTerminal = function() {
    if (terminalActive) closeTerminal();
    else openTerminal();
  };
  window.isTerminalOpen = function() {
    return terminalActive;
  };
})();
