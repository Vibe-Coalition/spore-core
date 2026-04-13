/**
 * web.js — Web Control Panel Gateway
 *
 * HTTP server, WebSocket control panel, REST API routes,
 * terminal/SSH handlers, and voice pipeline for the web UI.
 *
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const graphEvents = require('../graph/events');

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

class WebGateway {
  constructor(toolSystem) {
    this.tools = toolSystem;
    this.config = toolSystem.config;
    this.log = toolSystem.log;
    this.graph = toolSystem.graph;
    this.skills = toolSystem.skills;

    this._server = null;
    this._serverDir = null;
    this._wss = null;
    this._sshManager = null;
    this._voicePipeline = null;
    this._webSessions = new Map();
  }

  // ── Public API ──────────────────────────────────────────────────────

  get server() { return this._server; }
  get wss() { return this._wss; }

  handleAction(action, dir, opts = {}) {
    if (action === 'status') return this._status();
    if (action === 'stop') return this._stop();
    if (action === 'start') return this._start(dir);
    if (action === 'backend') return this._startWithBackend(dir, opts);
    return { error: `Unknown action: ${action}` };
  }

  broadcast(msg) {
    if (!this._wss) return;
    const data = JSON.stringify(msg);
    const creatorOnly = msg.type && msg.type.startsWith('benchmark:');
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (creatorOnly && client._role !== 'admin') continue;
      try { client.send(data); } catch { }
    }
  }

  broadcastBinary(buffer) {
    if (!this._wss) return;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try { client.send(buffer); } catch { }
    }
  }

  hasConnectedClients() {
    if (!this._wss) return false;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  _getActiveWebUser() {
    if (!this._wss) return 'operator';
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN && client._user) return client._user;
    }
    return 'operator';
  }

  getActiveChannelIds() {
    if (!this._wss || !this.hasConnectedClients()) return [];
    return [{ id: 'web:control-panel', name: 'web chat' }];
  }

  injectProactivePrompt(channelId, context, topic) {
    if (!this._wss || !this.hasConnectedClients()) {
      this.log.debug('[proactive:web] No connected clients, skipping');
      return;
    }

    const agent = this.tools?._agent;
    if (!agent) {
      this.log.debug('[proactive:web] Agent not available, skipping');
      return;
    }

    const prompt = `[proactive thought: ${context}${topic ? ` (topic: ${topic})` : ''}]`;
    const sessionId = channelId || 'web:control-panel';
    const activeUser = this._getActiveWebUser();

    if (!this._proactiveQueue) this._proactiveQueue = Promise.resolve();
    this._proactiveQueue = this._proactiveQueue.then(async () => {
      try {
        this.broadcast({ type: 'chat:start', sessionId });
        const result = await agent.processMessage({
          content: prompt,
          channelId: sessionId,
          channelName: 'control-panel',
          userId: activeUser,
          userName: 'System',
          trigger: 'proactive',
          platform: 'web',
          isDm: true,
          onTextDelta: (delta) => {
            this.broadcast({ type: 'chat:delta', text: delta });
          },
          onToolUse: (toolName) => {
            this.broadcast({ type: 'chat:tool', tool: toolName });
          },
          onStatus: (evt) => {
            try {
              if (evt.type?.startsWith('code:')) {
                this.broadcast(evt);
              } else {
                const { type: statusType, ...rest } = evt;
                this.broadcast({ type: 'chat:status', status: statusType, ...rest });
              }
            } catch { }
          },
        });

        const text = result?.text;
        if (!text || text.trim() === 'NO_REPLY' || text.includes('NO_REPLY')) {
          this.broadcast({ type: 'chat:done', text: '' });
          this.log.info('[proactive:web] Agent chose NO_REPLY');
        } else {
          this.broadcast({
            type: 'chat:done',
            text,
            usage: result.usage,
            iterations: result.iterations,
            toolUsage: result.toolUsage,
          });
          this.log.info(`[proactive:web] Delivered proactive message (${(text || '').length} chars)`);

          try {
            const feed = require('../graph/feed');
            feed.log({
              channelName: 'web:proactive',
              userName: 'System',
              userMessage: prompt,
              myResponse: text,
              trigger: 'proactive',
              usage: result.usage,
              iterations: result.iterations,
            });
          } catch {}
        }
      } catch (e) {
        this.log.warn(`[proactive:web] Failed: ${e.message}`);
        this.broadcast({ type: 'chat:done', text: '' });
      }
    }).catch(e => {
      this.log.warn(`[proactive:web] Queue error: ${e.message}`);
    });
  }

  async _isOAuthEnabled() {
    if (Date.now() - (this._oauthCheckedAt || 0) < 300_000) return this._oauthEnabled || false;
    if (!this.config.managerUrl) return false;
    try {
      const resp = await fetch(`${this.config.managerUrl}/api/auth/google/status`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      this._oauthEnabled = !!data.enabled;
    } catch {
      if (this._oauthEnabled === undefined) this._oauthEnabled = false;
    }
    this._oauthCheckedAt = Date.now();
    return this._oauthEnabled;
  }

  async handleHttp(req, res) {
    return false;
  }

  // ── Status / Stop ──────────────────────────────────────────────────

  _status() {
    const webPort = this.config.webPort;
    let pub = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
    if (!pub && this.config.ingressDomain) {
      const iP = (this.config.ingressPath || '').replace(/\/$/, '');
      const pr = this.config.ingressHttps ? 'https' : 'http';
      pub = `${pr}://${this.config.ingressDomain}${iP}`;
    }
    if (this._server) {
      const result = { running: true, port: webPort, dir: this._serverDir, url: pub ? `${pub}/` : `http://localhost:${webPort}/`, graphEditor: pub ? `${pub}/graph` : `http://localhost:${webPort}/graph`, publicUrl: pub || null };
      if (this._backendChild) {
        result.backend = { running: true, port: this._backendPort, pid: this._backendChild.pid };
      }
      return result;
    }
    return { running: false, port: webPort || null, note: webPort ? 'Server is not running. Use action:start to launch it.' : 'No web port configured. Set ANIMA_WEB_PORT and re-deploy.' };
  }

  _stop() {
    this._stopBackendProcess();
    try { fs.unlinkSync(path.join(this.config.dataDir, '.backend-config.json')); } catch {}
    if (!this._server) return { stopped: false, note: 'Server was not running.' };
    if (this._wss) { this._wss.close(); this._wss = null; }
    this._server.close();
    this._server = null;
    this._serverDir = null;
    this.log.info('[web_serve] Server stopped');
    return { stopped: true };
  }

  // ── Backend Process Management ─────────────────────────────────────

  _stopBackendProcess() {
    if (this._backendChild) {
      try { process.kill(-this._backendChild.pid, 'SIGTERM'); } catch {}
      try { this._backendChild.kill('SIGTERM'); } catch {}
      this._backendChild = null;
      this._backendPort = null;
      this.log.info('[web_serve] Backend process killed');
    }
    // Also kill anything on the .app-port
    const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
    try {
      const port = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10);
      if (port > 0) this._killProcessOnPort(port);
      fs.unlinkSync(appPortFile);
    } catch {}
  }

  _killProcessOnPort(port) {
    try {
      const { execSync } = require('child_process');
      const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          const p = parseInt(pid.trim(), 10);
          if (p > 0 && p !== process.pid) {
            try { process.kill(p, 'SIGTERM'); } catch {}
          }
        }
      }
    } catch {}
  }

  _allocateBackendPort() {
    const webPort = this.config.webPort || 18815;
    return webPort + 100;
  }

  _fetchVaultKeys() {
    const managerUrl = this.config.managerUrl || 'http://anima-manager:18900';
    const serviceKey = this.config.managerServiceKey || '';
    const agentId = this.config.agentId || 'unknown';
    const env = {};
    try {
      const { execSync } = require('child_process');
      const result = execSync(
        `curl -sf -H "X-Service-Key: ${serviceKey}" -H "X-Anima-Id: ${agentId}" "${managerUrl}/api/vault/keys" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const rawKeys = JSON.parse(result).keys || [];
      const keyNames = rawKeys.map(k => typeof k === 'string' ? k : k.name).filter(Boolean);
      for (const keyName of keyNames) {
        try {
          const val = execSync(
            `curl -sf -H "X-Service-Key: ${serviceKey}" -H "X-Anima-Id: ${agentId}" "${managerUrl}/api/vault/key?name=${encodeURIComponent(keyName)}" 2>/dev/null`,
            { encoding: 'utf8', timeout: 5000 }
          );
          const parsed = JSON.parse(val);
          if (parsed.value) env[keyName] = parsed.value;
        } catch {}
      }
    } catch (e) {
      this.log.warn(`[backend] Failed to fetch vault keys: ${e.message}`);
    }
    return env;
  }

  _startWithBackend(dir, { command, commandDir } = {}) {
    if (!command) return { error: 'command is required for action:"backend". Provide the command to start your backend (e.g. "node server.js").' };

    // Start the web server for static files
    const startResult = this._start(dir);
    if (startResult.error) return startResult;

    const serveDir = dir || path.join(this.config.workspacePath || process.cwd(), 'web');
    const backendPort = this._allocateBackendPort();
    const workDir = commandDir || serveDir;

    // Kill any stale backend
    this._stopBackendProcess();
    this._killProcessOnPort(backendPort);

    // Write .app-port before spawning so the proxy is ready
    const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
    try { fs.writeFileSync(appPortFile, String(backendPort)); } catch {}

    // Auto-inject vault keys into the backend process env
    const vaultKeys = this._fetchVaultKeys();
    const vaultKeyNames = Object.keys(vaultKeys);

    // Build env: base process env + allocated port + vault keys
    const { spawn } = require('child_process');
    const SENSITIVE_RE = /KEY|TOKEN|SECRET|PASS|CREDENTIALS|AUTH/i;
    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!SENSITIVE_RE.test(k)) baseEnv[k] = v;
    }
    const env = {
      ...baseEnv,
      APP_PORT: String(backendPort),
      PORT: String(backendPort),
      NODE_ENV: process.env.NODE_ENV || 'production',
      ...vaultKeys,
    };

    const child = spawn('sh', ['-c', command], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const childPid = child.pid;
    let lastStdout = '';
    let lastStderr = '';
    child.stdout?.on('data', (d) => {
      lastStdout = d.toString().slice(-500);
      this.log.debug(`[backend:stdout] ${lastStdout.trim()}`);
    });
    child.stderr?.on('data', (d) => {
      lastStderr = d.toString().slice(-500);
      this.log.debug(`[backend:stderr] ${lastStderr.trim()}`);
    });

    child.on('exit', (code, signal) => {
      if (this._backendChild === child) {
        this.log.warn(`[backend] Process exited unexpectedly: code=${code} signal=${signal}`);
        this._backendChild = null;
        this._backendPort = null;
      }
    });

    child.unref();
    this._backendChild = child;
    this._backendPort = backendPort;

    // Persist backend config so it auto-restores on container restart
    try {
      fs.writeFileSync(path.join(this.config.dataDir, '.backend-config.json'), JSON.stringify({
        dir: serveDir, command, commandDir: workDir,
      }));
    } catch {}

    let pubUrl = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
    if (!pubUrl && this.config.ingressDomain) {
      const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
      const proto = this.config.ingressHttps ? 'https' : 'http';
      pubUrl = `${proto}://${this.config.ingressDomain}${iPath}`;
    }
    const displayUrl = pubUrl || `http://localhost:${this.config.webPort}`;

    this.log.info(`[backend] Started (pid=${childPid}, port=${backendPort}), ${vaultKeyNames.length} vault key(s) injected${vaultKeyNames.length ? ': ' + vaultKeyNames.join(', ') : ''}`);

    return {
      started: true,
      port: this.config.webPort,
      backendPort,
      pid: childPid,
      dir: serveDir,
      commandDir: workDir,
      command,
      url: `${displayUrl}/`,
      publicUrl: pubUrl || null,
      vaultKeysInjected: vaultKeyNames,
      routing: {
        note: 'Traefik strips the path prefix before requests reach your server. Your backend sees paths relative to root.',
        externalBase: pubUrl || displayUrl,
        internalBackendPort: backendPort,
        frontendFetchPattern: `Your frontend HTML is served under ${displayUrl}/. Use RELATIVE fetch paths: fetch('api/generate') or fetch('./api/generate'). The web server proxies /api/* to your backend. For non-/api/ routes, any path that doesn't match a static file is also proxied to the backend.`,
        backendRoutes: `Your backend receives requests with the prefix ALREADY STRIPPED. If your HTML is at ${displayUrl}/myapp/, the backend sees /myapp/endpoint. Match routes like: /myapp/endpoint or /api/endpoint.`,
        vaultKeys: vaultKeyNames.length ? `These vault keys were auto-injected as env vars in your backend process: ${vaultKeyNames.join(', ')}. Access them with process.env.KEY_NAME — no need to use vault_get.` : 'No vault keys found. Add keys via the manager vault UI.',
      },
    };
  }

  // ── Start (HTTP server + all routes) ───────────────────────────────

  _start(dir) {
    const webPort = this.config.webPort;
    if (!webPort) return { error: 'No web port configured. Set ANIMA_WEB_PORT in .env and re-deploy the container.' };
    const serveDir_ = dir || path.join(this.config.workspacePath || process.cwd(), 'web');
    if (this._server) {
      if (this._serverDir === serveDir_) {
        this.log.info('[web_serve] Server already running for same dir, keeping connections alive');
        return { running: true, port: webPort, dir: this._serverDir, note: 'Server already active — kept existing connections.' };
      }
      if (this._wss) { this._wss.close(); this._wss = null; }
      this._server.close();
      this._server = null;
    }

    const serveDir = dir || path.join(this.config.workspacePath || process.cwd(), 'web');
    try { fs.mkdirSync(serveDir, { recursive: true }); } catch { }

    const indexPath = path.join(serveDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      const name = this.config.displayName || this.config.agentId || 'Anima';
      fs.writeFileSync(indexPath, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif}h1{font-size:2.5rem;opacity:.8}</style></head><body><h1>${name}</h1></body></html>`);
    }

    const MIME = {
      '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
      '.woff2': 'font/woff2', '.woff': 'font/woff',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
      '.webp': 'image/webp', '.avif': 'image/avif',
    };

    function parseMultipart(buf, boundary, destDir, maxFileSize) {
      const sep = Buffer.from('--' + boundary);
      const saved = [];
      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        const next = buf.indexOf(sep, start + sep.length);
        if (next === -1) break;
        const part = buf.slice(start + sep.length, next);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) { pos = next; continue; }
        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        if (!fnMatch) { pos = next; continue; }
        let fileName = fnMatch[1].replace(/[/\\]/g, '_').replace(/\.\./g, '');
        if (!fileName) { pos = next; continue; }
        let body = part.slice(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
          body = body.slice(0, body.length - 2);
        }
        if (body.length > maxFileSize) throw new Error(`File "${fileName}" exceeds size limit`);
        const dest = path.join(destDir, fileName);
        if (!dest.startsWith(destDir)) throw new Error('Invalid path');
        fs.writeFileSync(dest, body);
        saved.push(fileName);
        pos = next;
      }
      return saved;
    }

    const authUser = this.config.webAuthUser;
    const authPass = this.config.webAuthPass;
    const graphDb = this.graph?.db;

    const _sessions = this._webSessions;

    const _loginAttempts = new Map();
    const LOGIN_MAX_ATTEMPTS = 5;
    const LOGIN_WINDOW_MS = 15 * 60 * 1000;

    const _checkLoginRate = (req) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const entry = _loginAttempts.get(ip);
      if (entry) {
        entry.attempts = entry.attempts.filter(t => now - t < LOGIN_WINDOW_MS);
        if (entry.attempts.length >= LOGIN_MAX_ATTEMPTS) return false;
      }
      return true;
    };

    const _recordLoginAttempt = (req) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      if (!_loginAttempts.has(ip)) _loginAttempts.set(ip, { attempts: [] });
      _loginAttempts.get(ip).attempts.push(Date.now());
    };

    const _sessionSweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, sess] of _sessions) {
        if (now - sess.created >= SESSION_TTL) _sessions.delete(sid);
      }
      for (const [ip, entry] of _loginAttempts) {
        entry.attempts = entry.attempts.filter(t => now - t < LOGIN_WINDOW_MS);
        if (entry.attempts.length === 0) _loginAttempts.delete(ip);
      }
    }, 60 * 60 * 1000);
    _sessionSweepInterval.unref();

    const parseCookies = (req) => {
      const obj = {};
      (req.headers.cookie || '').split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) obj[k.trim()] = decodeURIComponent(v.join('='));
      });
      return obj;
    };

    const managerUrl = process.env.MANAGER_URL;
    const managerKey = process.env.MANAGER_SERVICE_KEY;
    const animaId = this.config.agentId;

    const tryManagerSSO = async (req, res, { webappOnly = false } = {}) => {
      if (!managerUrl || !managerKey) return false;
      const cookies = parseCookies(req);
      const mgrToken = cookies['manager_session'];
      if (!mgrToken) return false;
      try {
        const http_ = require('http');
        const payload = JSON.stringify({ token: mgrToken, animaId, webappOnly });
        const url = new URL(managerUrl + '/api/auth/verify-session');
        const result = await new Promise((resolve, reject) => {
          const r = http_.request({
            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-service-key': managerKey, 'Content-Length': Buffer.byteLength(payload) },
            timeout: 3000,
          }, (resp) => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
          });
          r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          r.end(payload);
        });
        if (result.ok && result.username) {
          const sid = crypto.randomBytes(32).toString('hex');
          if (webappOnly) {
            _sessions.set(sid, { type: 'webapp', created: Date.now(), user: result.username, viaSSO: true });
            const secure = process.env.ANIMA_INSECURE_COOKIES === 'true' ? '' : '; Secure';
            res.setHeader('Set-Cookie', `anima_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
            return 'webapp';
          }
          const mgrRole = result.role === 'super' ? 'admin' : 'creator';
          _sessions.set(sid, { type: mgrRole, created: Date.now(), user: result.username, viaSSO: true });
          const secure = process.env.ANIMA_INSECURE_COOKIES === 'true' ? '' : '; Secure';
          res.setHeader('Set-Cookie', `anima_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
          return mgrRole;
        }
      } catch (err) {
        this.log.warn(`[webapp-gate] SSO verify failed: ${err.message}`);
      }
      return false;
    };

    const checkCreatorAuth = (req, res) => {
      if (managerKey && req.headers['x-service-key'] === managerKey) return true;
      const cookies = parseCookies(req);
      const sid = cookies['anima_session'];
      if (sid && _sessions.has(sid)) {
        const sess = _sessions.get(sid);
        if ((sess.type === 'creator' || sess.type === 'admin') && Date.now() - sess.created < SESSION_TTL) {
          if (sess.viaSSO && !cookies['manager_session']) {
            _sessions.delete(sid);
            return false;
          }
          return true;
        }
        if (sess.type === 'creator' || sess.type === 'admin') _sessions.delete(sid);
      }
      if (authUser && authPass) {
        const authHeader = req.headers.authorization || '';
        if (authHeader.startsWith('Basic ')) {
          const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
          const [u, ...pParts] = decoded.split(':');
          if (u === authUser && pParts.join(':') === authPass) return true;
        }
      }
      return false;
    };

    const checkCreatorAuthAsync = async (req, res) => {
      if (checkCreatorAuth(req, res)) return true;
      if (await tryManagerSSO(req, res)) return true;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Creator authentication required' }));
      return false;
    };
    const checkAuth = (req, res) => checkCreatorAuthAsync(req, res);

    const WEBAPP_USERS_PATH = path.join(this.config.dataDir, 'webapp-users.json');
    const loadWebappUsers = () => {
      try { return JSON.parse(fs.readFileSync(WEBAPP_USERS_PATH, 'utf8')); } catch { return []; }
    };
    const verifyWebappPassword = (password, salt, storedHash) => {
      const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      if (computed.length !== storedHash.length) return false;
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
    };

    const checkWebappAuthSync = (req) => {
      const cookies = parseCookies(req);
      const csid = cookies['anima_session'];
      if (csid && _sessions.has(csid)) {
        const sess = _sessions.get(csid);
        if (sess.type === 'creator' && Date.now() - sess.created < SESSION_TTL) return true;
      }
      const wsid = cookies['anima_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (sess.type === 'webapp' && Date.now() - sess.created < SESSION_TTL) return true;
        if (sess.type === 'webapp') _sessions.delete(wsid);
      }
      return false;
    };

    const checkWebappAuth = async (req, res) => {
      if (checkWebappAuthSync(req)) return true;
      if (await tryManagerSSO(req, res)) return true;
      const wUsers = loadWebappUsers();
      const needsCreatorAuth = !!(managerUrl || (authUser && authPass));
      if (wUsers.length === 0 && !needsCreatorAuth) return true;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return false;
    };

    const isAnyAuth = (req) => {
      const cookies = parseCookies(req);
      const csid = cookies['anima_session'];
      if (csid && _sessions.has(csid)) {
        const sess = _sessions.get(csid);
        if (sess.viaSSO && !cookies['manager_session']) { _sessions.delete(csid); }
        else if (Date.now() - sess.created < SESSION_TTL) return sess.type;
      }
      const wsid = cookies['anima_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (Date.now() - sess.created < SESSION_TTL) return sess.type;
      }
      return null;
    };

    const getSessionFromReq = (req) => {
      const cookies = parseCookies(req);
      const sid = cookies['anima_session'];
      if (sid && _sessions.has(sid)) return sid;
      const wsid = cookies['anima_webapp'];
      if (wsid && _sessions.has(wsid)) return wsid;
      return null;
    };

    const server = http.createServer(async (req, res) => {
      const urlPath = req.url.split('?')[0];

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      if (req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }

      const origin = req.headers.origin || '';
      let isTrustedOrigin = false;
      try {
        if (origin) {
          const oh = new URL(origin).hostname;
          isTrustedOrigin = oh === 'localhost' || oh === '127.0.0.1' || oh === '::1';
        }
      } catch {}
      const ingressDomain = this.config.ingressDomain;
      let matchesIngress = false;
      if (ingressDomain && origin) {
        try { matchesIngress = new URL(origin).hostname === ingressDomain; } catch {}
      }
      const allowedOrigin = (isTrustedOrigin || matchesIngress) ? origin : '';
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── Creator auth endpoints (graph viewer SSO via manager) ──
      if (urlPath === '/api/auth/login' && req.method === 'POST') {
        if (!_checkLoginRate(req)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
          return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', async () => {
          try {
            _recordLoginAttempt(req);
            const { username, password } = JSON.parse(body);
            const serviceKey = managerKey;
            let verified = false;
            let verifiedUser = username;

            if (managerUrl && serviceKey) {
              try {
                const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
                const payload = JSON.stringify({ username, password, animaId });
                const result = await new Promise((resolve, reject) => {
                  const url = new URL(managerUrl + '/api/auth/verify-access');
                  const opts = {
                    method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
                    headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey, 'Content-Length': Buffer.byteLength(payload) },
                    timeout: 5000
                  };
                  const r = http_.request(opts, (resp) => {
                    let d = ''; resp.on('data', c => d += c);
                    resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d) }); } catch { reject(new Error('Bad response')); } });
                  });
                  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
                  r.write(payload); r.end();
                });
                if (result.status === 200 && result.body.ok) {
                  verified = true;
                  verifiedUser = result.body.username || username;
                  req._mgrRole = result.body.role;
                } else {
                  res.writeHead(result.status || 401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: result.body?.error || 'Invalid credentials' })); return;
                }
              } catch (e) {
                this.log.warn('[web] Manager SSO unreachable, falling back to local auth:', e.message);
                if (authUser && authPass && username === authUser && password === authPass) {
                  verified = true;
                } else {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
                }
              }
            } else if (authUser && authPass) {
              if (username === authUser && password === authPass) verified = true;
              else { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid credentials' })); return; }
            } else {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Auth not configured' })); return;
            }

            if (verified) {
              const sid = crypto.randomBytes(32).toString('hex');
              const loginRole = req._mgrRole === 'super' ? 'admin' : 'creator';
              _sessions.set(sid, { user: verifiedUser, created: Date.now(), type: loginRole });
              const secure = process.env.ANIMA_INSECURE_COOKIES === 'true' ? '' : '; Secure';
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `anima_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
              });
              res.end(JSON.stringify({ ok: true, user: verifiedUser, role: loginRole }));
            }
          } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad request' })); }
        });
        return;
      }

      if (urlPath === '/api/auth/logout' && req.method === 'POST') {
        const sid = getSessionFromReq(req);
        if (sid) _sessions.delete(sid);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'anima_session=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/auth/check') {
        let valid = false;
        let role = null;
        const cookies = parseCookies(req);
        const sid = cookies['anima_session'];
        const sess = sid && _sessions.get(sid);
        if (sess && (sess.type === 'creator' || sess.type === 'admin') && (Date.now() - sess.created < SESSION_TTL)) {
          valid = true;
          role = sess.type;
        }
        if (!valid) {
          const ssoRole = await tryManagerSSO(req, res);
          if (ssoRole) { valid = true; role = ssoRole; }
        }
        const hasWebappUsers = loadWebappUsers().length > 0;
        const needsAuth = !!(managerUrl || (authUser && authPass));
        const username = sess?.user || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: valid, needsAuth, role, hasWebappUsers, username }));
        return;
      }

      // ── Webapp user auth endpoints ──
      if (urlPath === '/api/webapp/login' && req.method === 'POST') {
        if (!_checkLoginRate(req)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
          return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          _recordLoginAttempt(req);
          try {
            const { username, password } = JSON.parse(body);
            const users = loadWebappUsers();
            if (users.length === 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, user: 'guest', noAuth: true })); return;
            }
            const user = users.find(u => u.username === username);
            if (!user || !verifyWebappPassword(password, user.salt, user.hash)) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
            }
            const sid = crypto.randomBytes(32).toString('hex');
            _sessions.set(sid, { user: username, created: Date.now(), type: 'webapp' });
            const secure = process.env.ANIMA_INSECURE_COOKIES === 'true' ? '' : '; Secure';
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': `anima_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
            });
            res.end(JSON.stringify({ ok: true, user: username }));
          } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad request' })); }
        });
        return;
      }

      if (urlPath === '/api/webapp/logout' && req.method === 'POST') {
        const cookies = parseCookies(req);
        const wsid = cookies['anima_webapp'];
        if (wsid && _sessions.has(wsid)) _sessions.delete(wsid);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'anima_webapp=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/webapp/check') {
        const wUsers = loadWebappUsers();
        let authType = isAnyAuth(req);
        if (!authType && await tryManagerSSO(req, res)) authType = 'creator';
        const needsAuth = wUsers.length > 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: !!authType, needsAuth, userType: authType }));
        return;
      }

      // /graph — serve without auth (HTML has its own login form)
      if (urlPath === '/graph' || urlPath === '/graph/') {
        try {
          const viewerPath = path.join(__dirname, '..', 'static', 'graph-viewer.html');
          let html = fs.readFileSync(viewerPath, 'utf8');
          const brandPath = path.join(__dirname, '..', 'static', 'brand.js');
          if (fs.existsSync(brandPath)) {
            const inline = `<script>\n${fs.readFileSync(brandPath, 'utf8')}\n</script>`;
            html = html.replace(/<script src="brand\.js"><\/script>/, inline);
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
          res.end(html);
        } catch { res.writeHead(500); res.end('Graph viewer not found.'); }
        return;
      }

      if (urlPath === '/brand.js') {
        try {
          const brandPath = path.join(__dirname, '..', 'static', 'brand.js');
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(fs.readFileSync(brandPath, 'utf8'));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }

      // ── Acorn CLI auth ──
      if (urlPath === '/api/acorn/auth' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            const { username, key } = JSON.parse(body);
            const acornKey = this.config.acornKey;
            if (!acornKey) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Acorn not configured on this agent' }));
              return;
            }
            if (!username || typeof username !== 'string' || username.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid username (alphanumeric, max 32 chars)' }));
              return;
            }
            if (!key || key !== acornKey) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid team key' }));
              return;
            }
            const acornSid = crypto.randomBytes(16).toString('hex');
            const webSessions = this._webSessions;
            webSessions.set(acornSid, { user: username.toLowerCase().trim(), type: 'acorn', created: Date.now() });
            this.log.info(`[acorn] Auth OK for user: ${username}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, token: acornSid, user: username }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
          }
        });
        return;
      }

      if (urlPath === '/api/ws-token') {
        const sid = getSessionFromReq(req);
        if (!sid) {
          if (!(await checkAuth(req, res))) return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: sid || '' }));
        return;
      }

      if (urlPath === '/api/identity') {
        if (!(await checkAuth(req, res))) return;
        const displayName = this.config.displayName || this.config.agentId || 'anima';
        const names = [displayName.toLowerCase()];
        if (Array.isArray(this.config.nicknames)) {
          this.config.nicknames.forEach(n => { if (n && !names.includes(n.toLowerCase())) names.push(n.toLowerCase()); });
        }
        try {
          const db = this.graph?.db || graphDb;
          if (db) {
            const agentId = this.config.agentId || 'anima';
            try {
              const aliases = db.prepare("SELECT alias FROM aliases WHERE node_id = ?").all(agentId);
              aliases.forEach(a => { if (a.alias && !names.includes(a.alias.toLowerCase())) names.push(a.alias.toLowerCase()); });
            } catch { }
          }
        } catch { }
        const pipeline = this._ensureVoicePipeline();
        const voiceEnabled = !!(pipeline);
        const sttEnabled = !!(pipeline?.stt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: displayName, names, voiceEnabled, sttEnabled }));
        return;
      }

      // ── Chatroom toggle API ──
      if (urlPath === '/api/chatroom/status' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const gw = this.tools._chatroomGateway;
        const connected = !!(gw && gw._ws && gw._ws.readyState === 1);
        const enabled = !gw?._closed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled, connected }));
        return;
      }

      if (urlPath === '/api/chatroom/toggle' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const gw = this.tools._chatroomGateway;
        if (!gw) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No chatroom gateway configured (MANAGER_URL not set)', enabled: false }));
          return;
        }
        const body = await new Promise((resolve) => {
          let d = '';
          req.on('data', c => { d += c; });
          req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        if (body.enabled === false) {
          gw.disconnect();
          this.log.info('[chatroom] Disconnected from chatroom (user toggle)');
        } else {
          gw._closed = false;
          gw.connect();
          this.log.info('[chatroom] Reconnecting to chatroom (user toggle)');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: !gw._closed }));
        return;
      }

      // ── LongMemEval Benchmark API ──
      if (urlPath === '/api/benchmark/longmemeval' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        try {
          if (this.tools._benchmarkRunner && this.tools._benchmarkRunner.phase !== 'done' && this.tools._benchmarkRunner.phase !== 'error' && this.tools._benchmarkRunner.phase !== 'cancelled' && this.tools._benchmarkRunner.phase !== 'idle') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Benchmark already running', phase: this.tools._benchmarkRunner.phase }));
            return;
          }
          let body = {};
          try { body = await new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); } catch { }
          const { variant = 'oracle', maxQuestions = 500, skipIngestion = false, forceReeval = false, learnerModel, answerModel, questionTypes } = body;
          const registry = this.tools._graphRegistry;
          if (!registry) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Multi-graph registry not available' })); return; }

          const prevSlug = registry.getActiveSlug();
          let slug;
          if (skipIngestion) {
            slug = prevSlug;
          } else {
            slug = registry.create(`LongMemEval ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, `LongMemEval benchmark (${variant})`);
            this.tools.switchGraph(slug);
            graphEvents.emit('change', { op: 'graph:switched', slug, source: 'benchmark' });
          }

          const { LongMemEvalRunner } = require('../benchmark/longmemeval');
          const runner = new LongMemEvalRunner({
            config: this.config,
            graph: this.graph,
            learner: this.tools.learner,
            maintainer: this.tools._maintainer || null,
            llmClient: this.tools.anthropicClient,
            log: this.log,
            broadcast: this.broadcast.bind(this),
            learnerModel: learnerModel || undefined,
            answerModel: answerModel || undefined,
          });
          this.tools._benchmarkRunner = runner;
          this.tools._benchmarkPrevSlug = prevSlug;

          runner.run({ variant, maxQuestions, skipIngestion, forceReeval, questionTypes: questionTypes || null }).catch(e => {
            this.log.error(`[longmemeval] Runner error: ${e.message}`);
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, slug, prevSlug, variant, maxQuestions }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (urlPath === '/api/benchmark/longmemeval/status' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const status = this.tools._benchmarkRunner ? this.tools._benchmarkRunner.getStatus() : { phase: 'idle' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      if (urlPath === '/api/benchmark/longmemeval/results' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        try {
          const graphDir = path.dirname(this.config.graphDbPath);
          const resultsPath = path.join(graphDir, 'longmemeval-results.json');
          const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ empty: true }));
        }
        return;
      }

      if (urlPath === '/api/benchmark/longmemeval/cancel' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (this.tools._benchmarkRunner) {
          this.tools._benchmarkRunner.cancel();
          if (this.tools._benchmarkPrevSlug && this.tools._graphRegistry) {
            try {
              this.tools.switchGraph(this.tools._benchmarkPrevSlug);
              graphEvents.emit('change', { op: 'graph:switched', slug: this.tools._benchmarkPrevSlug, source: 'benchmark-cancel' });
            } catch (e) { this.log.warn(`[longmemeval] Failed to switch back: ${e.message}`); }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Multi-Graph Management API ──
      if (urlPath.startsWith('/api/graphs')) {
        if (!(await checkAuth(req, res))) return;
        await this._handleMultiGraphApi(req, res, urlPath);
        return;
      }

      // Enhanced Recall toggle
      if (urlPath === '/api/enhanced-recall') {
        if (!(await checkAuth(req, res))) return;
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enhancedRecall: !!this.config.enhancedRecall }));
          return;
        }
        if (req.method === 'PUT') {
          const body = await new Promise((resolve, reject) => {
            let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
          });
          this.config.enhancedRecall = !!body.enabled;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, enhancedRecall: this.config.enhancedRecall }));
          return;
        }
      }

      if (urlPath.startsWith('/api/graph') || urlPath === '/api/tokens') {
        if (!(await checkAuth(req, res))) return;
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      if (urlPath.startsWith('/files/')) {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const relPath = decodeURIComponent(urlPath.slice(7));
        const filePath = path.join(workspace, relPath);
        if (!filePath.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const data = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const params = new URL(req.url, 'http://x').searchParams;
          const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
          if (params.get('download') === '1') {
            headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
          }
          res.writeHead(200, headers);
          res.end(data);
        } catch { res.writeHead(404); res.end('File not found'); }
        return;
      }

      if (urlPath === '/api/preferences') {
        const PREFS_PATH = path.join(this.config.dataDir, 'preferences.json');
        const VALID_THEMES = ['midnight', 'dark', 'paper', 'terminal', 'ember', 'arctic', 'neon', 'forest'];
        const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; } };
        const authType = isAnyAuth(req);
        if (!authType) { if (!(await tryManagerSSO(req, res))) { res.writeHead(401); res.end('{}'); return; } }
        const cookies = parseCookies(req);
        let username = 'default';
        const sid = cookies['anima_session'];
        const sess = sid && _sessions.get(sid);
        if (sess?.username) username = sess.username;
        else {
          const wsid = cookies['anima_webapp'];
          const wsess = wsid && _sessions.get(wsid);
          if (wsess?.username) username = wsess.username;
        }
        if (req.method === 'GET') {
          const prefs = loadPrefs();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ theme: prefs[username]?.theme || 'midnight' }));
          return;
        }
        if (req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          try {
            const { theme } = JSON.parse(body);
            const prefs = loadPrefs();
            if (!prefs[username]) prefs[username] = {};
            prefs[username].theme = VALID_THEMES.includes(theme) ? theme : 'midnight';
            fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, theme: prefs[username].theme }));
          } catch { res.writeHead(400); res.end('{"error":"invalid body"}'); }
          return;
        }
      }

      if (urlPath === '/api/logs') {
        if (!(await checkAuth(req, res))) return;
        const maxLines = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('lines') || '500'), 2000);
        const logRing = this.log._ring || [];
        const output = logRing.slice(-maxLines).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(output || '[no log entries captured yet]');
        return;
      }

      if (urlPath === '/api/workspace') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const subdir = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const target = path.join(workspace, subdir);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const entries = fs.readdirSync(target, { withFileTypes: true }).map(e => {
            const stat = (() => { try { return fs.statSync(path.join(target, e.name)); } catch { return null; } })();
            return { name: e.name, isDir: e.isDirectory(), size: stat?.size || 0, modified: stat?.mtime || null };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: subdir || '/', entries }));
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'Directory not found' })); }
        return;
      }

      if (urlPath === '/api/workspace/mkdir' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const params = new URL(req.url, 'http://x').searchParams;
        const parentDir = params.get('path') || '';
        const folderName = params.get('name') || '';
        if (!folderName || folderName.includes('/') || folderName.includes('..')) {
          res.writeHead(400); res.end('Invalid folder name'); return;
        }
        const target = path.join(workspace, parentDir, folderName);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          fs.mkdirSync(target, { recursive: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end('Failed to create directory: ' + e.message); }
        return;
      }

      if (urlPath === '/api/workspace/file' && req.method === 'DELETE') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const filePath = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!filePath.startsWith(workspace) || filePath === workspace) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end('Failed to delete: ' + e.message); }
        return;
      }

      if (urlPath === '/api/workspace/save' && req.method === 'PUT') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const filePath = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!filePath.startsWith(workspace) || filePath === workspace) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > 10 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
        req.on('end', () => {
          try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.concat(chunks));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) { res.writeHead(500); res.end('Save failed: ' + e.message); }
        });
        return;
      }

      if (urlPath === '/api/workspace/upload' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const destDir = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!destDir.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const MAX_UPLOAD = 10 * 1024 * 1024;
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          res.writeHead(400); res.end('Expected multipart/form-data'); return;
        }
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
        const boundary = boundaryMatch[1].trim();
        const chunks = [];
        let totalSize = 0;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_UPLOAD * 10) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const saved = parseMultipart(buf, boundary, destDir, MAX_UPLOAD);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: saved }));
          } catch (e) { res.writeHead(500); res.end('Upload failed: ' + e.message); }
        });
        return;
      }

      // ── Workspace tree (recursive listing for sync diffing) ──
      if (urlPath === '/api/workspace/tree') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const subdir = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const target = path.join(workspace, subdir);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const walkDir = (dir, prefix) => {
          const results = [];
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const rel = prefix ? `${prefix}/${e.name}` : e.name;
              const full = path.join(dir, e.name);
              try {
                const stat = fs.statSync(full);
                if (e.isDirectory()) {
                  results.push(...walkDir(full, rel));
                } else {
                  results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
                }
              } catch {}
            }
          } catch {}
          return results;
        };
        try {
          const files = walkDir(target, '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ root: subdir || '/', files }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        return;
      }

      // ── Batch upload (preserves relative paths for sync) ──
      if (urlPath === '/api/workspace/upload-batch' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const basePath = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const baseDir = path.join(workspace, basePath);
        if (!baseDir.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const MAX_BATCH = 50 * 1024 * 1024;
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          res.writeHead(400); res.end('Expected multipart/form-data'); return;
        }
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
        const chunks = [];
        let totalSize = 0;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_BATCH) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const boundary = boundaryMatch[1].trim();
            const parts = buf.toString('binary').split('--' + boundary);
            const saved = [];
            for (const part of parts) {
              if (part === '--\r\n' || part === '--' || !part.trim()) continue;
              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd === -1) continue;
              const headerStr = part.substring(0, headerEnd);
              const nameMatch = headerStr.match(/name="([^"]+)"/);
              const filenameMatch = headerStr.match(/filename="([^"]+)"/);
              if (!filenameMatch) continue;
              const relPath = nameMatch ? nameMatch[1] : filenameMatch[1];
              let body = part.substring(headerEnd + 4);
              if (body.endsWith('\r\n')) body = body.slice(0, -2);
              const dest = path.join(baseDir, relPath);
              if (!dest.startsWith(baseDir)) continue;
              const dir = path.dirname(dest);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(dest, Buffer.from(body, 'binary'));
              saved.push(relPath);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: saved }));
          } catch (e) { res.writeHead(500); res.end('Batch upload failed: ' + e.message); }
        });
        return;
      }

      // ── Remote (SSH/SFTP) file operations ──
      if (urlPath.startsWith('/api/remote/')) {
        if (!(await checkAuth(req, res))) return;
        const mgr = this._ensureSSHManager();
        if (!mgr) { res.writeHead(503); res.end(JSON.stringify({ error: 'SSH manager not available' })); return; }
        const params = new URL(req.url, 'http://x').searchParams;
        const hostId = params.get('host');
        if (!hostId) { res.writeHead(400); res.end(JSON.stringify({ error: 'host parameter required' })); return; }
        const remotePath = params.get('path') || '/';

        try {
          if (urlPath === '/api/remote/ls') {
            const entries = await mgr.sftpListDir(hostId, remotePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: remotePath, entries }));
          } else if (urlPath === '/api/remote/read') {
            const data = await mgr.sftpReadFile(hostId, remotePath);
            const ext = path.extname(remotePath).toLowerCase();
            const MIME_MAP = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
            const headers = { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' };
            if (params.get('download') === '1') {
              headers['Content-Disposition'] = `attachment; filename="${path.basename(remotePath)}"`;
            }
            res.writeHead(200, headers);
            res.end(data);
          } else if (urlPath === '/api/remote/write' && req.method === 'POST') {
            const contentType = req.headers['content-type'] || '';
            if (contentType.includes('multipart/form-data')) {
              const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
              if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', async () => {
                try {
                  const buf = Buffer.concat(chunks);
                  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'sftp-upload-'));
                  const saved = parseMultipart(buf, boundaryMatch[1].trim(), tmpDir, 10 * 1024 * 1024);
                  for (const fileName of saved) {
                    const localPath = path.join(tmpDir, fileName);
                    const content = fs.readFileSync(localPath);
                    const destPath = remotePath.endsWith('/') ? remotePath + fileName : remotePath + '/' + fileName;
                    await mgr.sftpWriteFile(hostId, destPath, content);
                    fs.unlinkSync(localPath);
                  }
                  fs.rmdirSync(tmpDir, { recursive: true });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, files: saved }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
              });
            } else {
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', async () => {
                try {
                  const result = await mgr.sftpWriteFile(hostId, remotePath, Buffer.concat(chunks));
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, ...result }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
              });
            }
          } else if (urlPath === '/api/remote/mkdir' && req.method === 'POST') {
            const name = params.get('name') || '';
            const target = remotePath.endsWith('/') ? remotePath + name : remotePath + '/' + name;
            await mgr.sftpMkdir(hostId, target);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (urlPath === '/api/remote/file' && req.method === 'DELETE') {
            await mgr.sftpDelete(hostId, remotePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown remote endpoint' }));
          }
        } catch (e) {
          this.log.warn(`[remote-api] ${urlPath} error: ${e.message}`);
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
      }

      // ── Shared Skills API ──
      if (urlPath.startsWith('/api/skills')) {
        if (!(await checkAuth(req, res))) return;
        try {
          const params = new URL(req.url, 'http://x').searchParams;
          if (urlPath === '/api/skills' && req.method === 'GET') {
            const query = params.get('q') || '';
            const tags = params.get('tags') ? params.get('tags').split(',').map(t => t.trim()) : null;
            const result = this.skills.list(query || undefined, tags || undefined);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/read' && req.method === 'GET') {
            const slug = params.get('slug');
            if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'slug required' })); return; }
            const result = this.skills.read(slug);
            if (result.error) { res.writeHead(404); res.end(JSON.stringify(result)); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/save' && req.method === 'POST') {
            const chunks = [];
            req.on('data', c => { chunks.push(c); });
            req.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const result = this.skills.write(body.slug, {
                  title: body.title, tags: body.tags, author: body.author || 'web-ui',
                  summary: body.summary, content: body.content, mode: body.mode || 'replace',
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
              } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
            });
          } else if (urlPath === '/api/skills/delete' && req.method === 'DELETE') {
            const slug = params.get('slug');
            if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'slug required' })); return; }
            const result = this.skills.remove(slug);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/rebuild' && req.method === 'POST') {
            const index = this.skills._rebuildIndex();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: index.length }));
          } else {
            res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown skills endpoint' }));
          }
        } catch (e) {
          this.log.warn(`[skills-api] ${urlPath} error: ${e.message}`);
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
      }

      // ── Secure API Key Proxy ──
      // Agents write /workspace/web/.api-proxy.json to define routes.
      // Frontend calls /api/proxy/<route> and the server injects env keys server-side.
      // Keys never reach the browser.
      if (urlPath.startsWith('/api/proxy/')) {
        const proxyRoute = urlPath.slice('/api/proxy/'.length);
        const proxyConfig = this._loadApiProxyConfig();
        const matched = proxyConfig && this._matchProxyRoute(proxyRoute, proxyConfig, req);
        if (matched) {
          await this._handleApiProxy(req, res, matched, proxyRoute);
          return;
        }
        if (proxyConfig) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No proxy route matched: ${proxyRoute}`, available: Object.keys(proxyConfig.routes || {}) }));
          return;
        }
      }

      // ── User App Proxy ──
      // If /workspace/.app-port exists, proxy unmatched /api/* requests to that port.
      // Accepts creator auth, webapp session, or manager SSO.
      if (urlPath.startsWith('/api/')) {
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch {}
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== webPort) {
          const authType = isAnyAuth(req);
          if (!authType && !checkCreatorAuth(req, res) && !(await tryManagerSSO(req, res))) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required for app proxy' }));
            return;
          }
          const safeHeaders = { host: `127.0.0.1:${appPort}` };
          const allowProxyHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding', 'x-request-id', 'x-forwarded-for'];
          for (const h of allowProxyHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: appPort,
            path: req.url,
            method: req.method,
            headers: safeHeaders,
          }, (proxyRes) => {
            const fwdHeaders = Object.assign({}, proxyRes.headers);
            delete fwdHeaders['access-control-allow-origin'];
            if (allowedOrigin) fwdHeaders['access-control-allow-origin'] = allowedOrigin;
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', (e) => {
            this.log.warn(`[app-proxy] Proxy to :${appPort} failed: ${e.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'App backend unavailable' }));
            }
          });
          req.pipe(proxyReq);
          return;
        }
      }

      // ── Webapp login page ──
      if (urlPath === '/login' || urlPath === '/login/') {
        const displayName = this.config.displayName || this.config.agentId || 'Anima';
        const brandJs = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'static', 'brand.js'), 'utf8'); } catch { return ''; } })();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Sign in - ${displayName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{height:100vh;display:flex;align-items:center;justify-content:center;background:#08090e;color:#c8cdd8;font-family:'Inter',system-ui,sans-serif}
.login-box{width:340px;padding:36px 32px 28px;background:rgba(14,16,23,.85);border:1px solid #1e2133;border-radius:14px;backdrop-filter:blur(24px);text-align:center}
.login-box h1{font-size:1.15rem;font-weight:600;color:#e2e6f0;margin-bottom:4px}
.login-box .sub{font-size:.78rem;color:#4a4f68;margin-bottom:20px}
.login-box label{display:block;text-align:left;font-size:.68rem;color:#4a4f68;letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px;margin-top:12px}
.login-box input{width:100%;padding:10px 12px;border:1px solid #1e2133;border-radius:8px;background:#0e1017;color:#e2e6f0;font-size:.88rem;outline:none}
.login-box input:focus{border-color:#5b8af5;box-shadow:0 0 0 2px rgba(91,138,245,.15)}
.login-box .btn{width:100%;margin-top:18px;padding:11px;border:none;border-radius:8px;cursor:pointer;font-size:.88rem;font-weight:600;color:#fff;background:linear-gradient(135deg,#5b8af5,#8b6cf7)}
.login-box .btn:hover{opacity:.9}.btn:disabled{opacity:.5;cursor:not-allowed}
.err{color:#f05858;font-size:.78rem;margin-top:8px;display:none}
</style></head><body>
<div class="login-box">
<h1>${displayName}</h1>
<div class="sub">Sign in to continue</div>
<div class="err" id="err"></div>
<form id="f" autocomplete="on">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required>
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
<button type="submit" class="btn">Sign in</button>
</form>
</div>
<script>${brandJs}
const API=window.location.pathname.replace(/\\/login\\/?$/,'');
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const err=document.getElementById('err');err.style.display='none';
const r=await fetch(API+'/api/webapp/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value.trim(),password:document.getElementById('p').value})});
const d=await r.json();if(r.ok&&d.ok){window.location.href=API+'/';}else{err.textContent=d.error||'Invalid credentials';err.style.display='block';}};
</script></body></html>`);
        return;
      }

      // ── Static files: webapp auth / OAuth gate ──
      {
        const wUsers = loadWebappUsers();
        const oauthEnabled = await this._isOAuthEnabled();
        const requireAuth = wUsers.length > 0 || oauthEnabled;
        if (requireAuth && !isAnyAuth(req)) {
          const cookies = parseCookies(req);
          const hasMgr = !!cookies['manager_session'];
          this.log.info(`[webapp-gate] ${urlPath} — oauth=${oauthEnabled} hasMgrCookie=${hasMgr} wUsers=${wUsers.length}`);
          let ssoResult;
          if (oauthEnabled && (ssoResult = await tryManagerSSO(req, res, { webappOnly: true }))) {
            this.log.info(`[webapp-gate] OAuth SSO succeeded: ${ssoResult}`);
          }
          else if (!oauthEnabled && (ssoResult = await tryManagerSSO(req, res))) {
            this.log.info(`[webapp-gate] Creator SSO succeeded: ${ssoResult}`);
          }
          else if (oauthEnabled) {
            const proto = this.config.ingressHttps ? 'https' : 'http';
            const domain = this.config.ingressDomain;
            const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
            const returnTo = domain ? `${proto}://${domain}${iPath}${urlPath}` : '';
            const managerUrl = returnTo ? `/manager/?returnTo=${encodeURIComponent(returnTo)}` : '/manager/';
            res.writeHead(302, { 'Location': managerUrl });
            res.end(); return;
          }
          else if (urlPath === '/' || urlPath === '/index.html') {
            const basePath = (this.config.ingressPath || '').replace(/\/$/, '');
            res.writeHead(302, { 'Location': basePath + '/login' });
            res.end(); return;
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
          }
        }
      }

      let filePath = path.join(serveDir, urlPath);

      if (!filePath.startsWith(serveDir)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch { }

      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        // If a backend is running, proxy non-file requests to it (SPA routing, etc.)
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch {}
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== webPort) {
          const safeHeaders = { host: `127.0.0.1:${appPort}` };
          const allowProxyHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding', 'cookie'];
          for (const h of allowProxyHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: appPort, path: req.url,
            method: req.method, headers: safeHeaders,
          }, (proxyRes) => {
            const fwdHeaders = Object.assign({}, proxyRes.headers);
            delete fwdHeaders['access-control-allow-origin'];
            if (allowedOrigin) fwdHeaders['access-control-allow-origin'] = allowedOrigin;
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', () => {
            if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end(`404 Not Found: ${req.url}`); }
          });
          req.pipe(proxyReq);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${req.url}`);
      }
    });

    server.listen(webPort, '0.0.0.0', () => {
      const isWSL = (() => { try { return require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();
      const hostAddr = isWSL
        ? (require('child_process').execSync('hostname -I', { encoding: 'utf8' }).trim().split(/\s+/)[0] || 'localhost')
        : 'localhost';
      this.log.info(`[web_serve] Serving ${serveDir} on port ${webPort}`);
      this.log.info(`[web_serve] URL: http://${hostAddr}:${webPort}`);
    });

    server.on('error', (e) => {
      this.log.error(`[web_serve] Server error: ${e.message}`);
      this._server = null;
    });

    this._server = server;
    this._serverDir = serveDir;

    try { fs.writeFileSync(path.join(this.config.dataDir, '.web-serve-dir'), serveDir); } catch { }

    this._setupWebSocket(server, authUser, authPass);

    let pubUrl = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
    if (!pubUrl && this.config.ingressDomain) {
      const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
      const proto = this.config.ingressHttps ? 'https' : 'http';
      pubUrl = `${proto}://${this.config.ingressDomain}${iPath}`;
    }
    const displayUrl = pubUrl || `http://localhost:${webPort}`;
    return { started: true, port: webPort, dir: serveDir, url: `${displayUrl}/`, graphEditor: `${displayUrl}/graph`, publicUrl: pubUrl || null, note: pubUrl ? `Public URL: ${pubUrl}/ — files written here are served immediately.` : 'Files written to this directory are served immediately — no restart needed. Graph editor at /graph (auth required).' };
  }

  // ── Voice Pipeline ──────────────────────────────────────────────────

  _ensureVoicePipeline() {
    if (this._voicePipeline) return this._voicePipeline;
    if (!this.config.voice?.enabled) return null;
    try {
      const { VoicePipeline } = require('../voice');
      this._voicePipeline = new VoicePipeline(this.config, this.log);
      return this._voicePipeline.enabled ? this._voicePipeline : null;
    } catch (e) {
      this.log.warn(`[voice] Pipeline init failed: ${e.message}`);
      return null;
    }
  }

  // ── WebSocket ───────────────────────────────────────────────────────

  _setupWebSocket(httpServer, authUser, authPass) {
    const WebSocket = require('ws');

    const wss = new WebSocket.Server({ noServer: true });
    this._wss = wss;

    const PING_INTERVAL = 25000;
    const pingTimer = setInterval(() => {
      for (const client of wss.clients) {
        if (client._missedPongs >= 3) {
          this.log.debug('[ws] Terminating unresponsive client (3 missed pongs)');
          client.terminate();
          continue;
        }
        client._missedPongs = (client._missedPongs || 0) + 1;
        try { client.ping(); } catch { }
      }
    }, PING_INTERVAL);
    wss.on('close', () => clearInterval(pingTimer));

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/ws/app') {
        if (authUser && authPass) {
          const cookies = {};
          (req.headers.cookie || '').split(';').forEach(c => {
            const [k, ...v] = c.trim().split('=');
            if (k) cookies[k.trim()] = v.join('=');
          });
          const sid = cookies['anima_session'];
          const sess = sid && _sessions.get(sid);
          if (!sess || (sess.type !== 'creator' && sess.type !== 'admin') || Date.now() - sess.created >= SESSION_TTL) {
            socket.destroy(); return;
          }
        }
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        const wPort = this.config.webPort;
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch {}
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== wPort) {
          const safeHeaders = {};
          const allowHeaders = ['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
          for (const h of allowHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: appPort, path: req.url,
            method: 'GET', headers: safeHeaders,
          });
          proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
              Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
              '\r\n\r\n');
            if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
            proxySocket.pipe(socket).pipe(proxySocket);
            proxySocket.on('error', () => socket.destroy());
            socket.on('error', () => proxySocket.destroy());
          });
          proxyReq.on('error', () => socket.destroy());
          proxyReq.end();
          return;
        }
        socket.destroy(); return;
      }

      if (url.pathname !== '/ws') { socket.destroy(); return; }

      const webSessions = this._webSessions || new Map();
      const token = url.searchParams.get('token');
      let wsRole = null;
      if (token && webSessions.has(token)) {
        const sess = webSessions.get(token);
        if (Date.now() - sess.created < SESSION_TTL) {
          wsRole = sess.type || null;
        } else {
          webSessions.delete(token);
          socket.destroy(); return;
        }
      } else if (authUser && authPass && token) {
        const decoded = Buffer.from(token, 'base64').toString();
        const [u, ...pParts] = decoded.split(':');
        if (u !== authUser || pParts.join(':') !== authPass) { socket.destroy(); return; }
        wsRole = 'creator';
      } else if (authUser && authPass) {
        socket.destroy(); return;
      } else if (token) {
        socket.destroy(); return;
      }

      let wsUser = null;
      if (token && webSessions.has(token)) {
        const sess = webSessions.get(token);
        wsUser = sess.user || null;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws._role = wsRole;
        ws._user = wsUser;
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      const isAcornClient = ws._role === 'acorn';
      this.log.info(`[ws] Client connected${isAcornClient ? ` (acorn: ${ws._user})` : ' to control panel'}`);
      ws._missedPongs = 0;
      ws._pendingTools = new Map();
      ws.on('pong', () => { ws._missedPongs = 0; });

      // Acorn clients manage their own session history — don't send web panel history
      if (!isAcornClient) {
        try {
          if (this.tools._sessions) {
            const sessionKey = this.tools._sessions.constructor.buildKey('web:control-panel', true, ws._user || 'operator');
            const rows = this.tools._sessions.db.prepare(
              `SELECT role, content, created FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT 60`
            ).all(sessionKey);
            rows.reverse();
            const history = [];
            for (const row of rows) {
              let text = row.content;
              try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                  text = parsed.filter(b => b.type === 'text').map(b => b.text).join('\n');
                  if (!text) {
                    const toolResults = parsed.filter(b => b.type === 'tool_result');
                    if (toolResults.length) continue;
                    const toolUses = parsed.filter(b => b.type === 'tool_use');
                    if (toolUses.length) { text = toolUses.map(t => '\u2699 ' + t.name).join(', '); }
                  }
                }
              } catch { }
              if (!text || !text.trim()) continue;
              if (text.startsWith('[BACKGROUND TASK')) continue;
              const role = row.role === 'assistant' ? 'assistant' : row.role === 'notification' ? 'notification' : 'user';
              history.push({ role, text: text.substring(0, 2000), ts: row.created });
            }
            if (history.length) {
              ws.send(JSON.stringify({ type: 'chat:history', messages: history }));
            }
          }
        } catch (e) { this.log.warn('[ws] Failed to send chat history:', e.message); }

        // Tell reconnecting web clients if the agent is mid-turn so they restore busy state
        try {
          const agent = this.tools._agent;
          const userId = ws._user || 'operator';
          const activeKeys = agent ? [...agent.activeRuns] : [];
          this.log.info(`[ws] Connect: user=${userId}, activeRuns=${activeKeys.length > 0 ? activeKeys.join(',') : 'none'}`);
          if (agent && activeKeys.length > 0) {
            const webBusy = activeKeys.some(k => k.startsWith('dm:'));
            if (webBusy) {
              ws.send(JSON.stringify({ type: 'chat:busy' }));
              this.log.info(`[ws] Sent chat:busy to reconnecting client`);
            }
          }
        } catch (e) { this.log.warn('[ws] Busy check failed:', e.message); }
      }

      // Graph events only for web panel clients, not Acorn
      const onGraphEvent = isAcornClient ? null : (evt) => {
        try { ws.send(JSON.stringify({ type: 'graph:event', ...evt })); } catch { }
      };
      if (onGraphEvent) graphEvents.on('change', onGraphEvent);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'ping') {
          ws._missedPongs = 0;
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch { }
          return;
        }

        if (msg.type === 'code:save') {
          try {
            const result = this.tools.executeTool('write_file', { path: msg.path, content: msg.content });
            // executeTool may be sync (write_file is sync) or async
            const handleResult = (r) => {
              if (r && r.error) {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: r.error }));
              } else {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, success: true, bytes: r?.bytes }));
                this.log.info(`[code-viewer] User saved ${msg.path} (${msg.content?.length || 0} chars)`);
              }
            };
            if (result && typeof result.then === 'function') {
              result.then(handleResult).catch(e => {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: e.message }));
              });
            } else {
              handleResult(result);
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: e.message }));
          }
          return;
        }

        // ── Acorn: request history for a specific session ──
        if (msg.type === 'chat:history-request' && msg.sessionId) {
          try {
            if (this.tools._sessions) {
              const isAcorn = ws._role === 'acorn';
              const reqSessionId = msg.sessionId;
              const userId = ws._user || 'operator';
              // Use legacy buildKey format to match how processMessage stores messages
              const historyKey = isAcorn
                ? this.tools._sessions.constructor.buildKey(reqSessionId, false, userId)
                : this.tools._sessions.constructor.buildKey(reqSessionId, true, userId);
              const rows = this.tools._sessions.db.prepare(
                `SELECT role, content, created FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT 60`
              ).all(historyKey);
              rows.reverse();
              const history = [];
              for (const row of rows) {
                let text = row.content;
                try {
                  const parsed = JSON.parse(text);
                  if (Array.isArray(parsed)) {
                    text = parsed.filter(b => b.type === 'text').map(b => b.text).join('\n');
                    if (!text) continue;
                  }
                } catch { }
                if (!text || !text.trim()) continue;
                const role = row.role === 'assistant' ? 'assistant' : 'user';
                history.push({ role, text: text.substring(0, 2000), ts: row.created });
              }
              ws.send(JSON.stringify({ type: 'chat:history', messages: history, sessionId: reqSessionId }));
              this.log.info(`[ws] History sent for ${reqSessionId}: ${history.length} messages`);
            }
          } catch (e) { this.log.warn('[ws] History request failed:', e.message); }
          return;
        }

        // ── Acorn: tool result from CLI client ──
        if (msg.type === 'tool:result') {
          const pending = ws._pendingTools?.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            ws._pendingTools.delete(msg.id);
            pending.resolve(msg.result);
          }
          return;
        }

        if (msg.type === 'chat:stop') {
          if (this.tools._agent) {
            const userId = ws._user || 'operator';
            const sessionId = msg.sessionId || 'web:control-panel';
            const isAcorn = ws._role === 'acorn';
            const stopped = isAcorn
              ? this.tools._agent.abortSession(sessionId, false, userId)
              : this.tools._agent.abortSession('web:control-panel', true, userId);
            this.log.info(`[ws] Stop requested for ${userId} — ${stopped ? 'aborted' : 'no active run'}`);
            if (stopped) {
              try { ws.send(JSON.stringify({ type: 'chat:status', status: 'stopping' })); } catch {}
            }
          }
          return;
        }

        if (msg.type === 'chat:clear') {
          if (this.tools._sessions) {
            const userId = ws._user || 'operator';
            const isAcorn = ws._role === 'acorn';
            const clearSessionId = msg.sessionId || 'web:control-panel';
            const clearKey = isAcorn
              ? this.tools._sessions.constructor.buildKey(clearSessionId, false, userId)
              : this.tools._sessions.constructor.buildKey('web:control-panel', true, userId);
            this.tools._sessions.clearSession(clearKey);
            ws.send(JSON.stringify({ type: 'chat:cleared' }));
            this.log.info(`[ws] Chat history cleared by ${userId}${isAcorn ? ` (acorn: ${clearSessionId})` : ''}`);
          }
          return;
        }

        if (msg.type === 'chat') {
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'chat:error', error: 'Agent not available' }));
            return;
          }
          const sessionId = msg.sessionId || 'web:control-panel';
          const isAcorn = ws._role === 'acorn';
          try {
            // Only broadcast chat:start to web panel for non-Acorn sessions.
            // Acorn sessions are isolated — leaking events locks up the web panel.
            if (!isAcorn) {
              this.broadcast({ type: 'chat:start', sessionId });
            }
            const images = Array.isArray(msg.images) ? msg.images.map(img => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data },
            })) : undefined;
            // Save non-image file attachments to disk
            let fileNote = '';
            if (Array.isArray(msg.files) && msg.files.length > 0) {
              const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
              try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}
              const savedFiles = [];
              for (const f of msg.files) {
                try {
                  const safeName = (f.name || `file-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
                  const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
                  fs.writeFileSync(filePath, Buffer.from(f.data, 'base64'));
                  savedFiles.push(filePath);
                  this.log.info(`[upload] Saved file to ${filePath}`);
                } catch (e) { this.log.warn(`[upload] Failed: ${e.message}`); }
              }
              if (savedFiles.length) fileNote = `\n[Attached files saved to disk: ${savedFiles.join(', ')}]`;
            }
            const result = await this.tools._agent.processMessage({
              content: msg.content + fileNote,
              channelId: sessionId,
              channelName: isAcorn ? `acorn:${ws._user}` : 'control-panel',
              userId: ws._user || 'operator',
              userName: ws._user || msg.userName || 'Operator',
              trigger: 'dm',
              platform: isAcorn ? 'cli' : 'web',
              isDm: !isAcorn,
              images,
              onTextDelta: (delta) => {
                try { ws.send(JSON.stringify({ type: 'chat:delta', text: delta })); } catch { }
              },
              onToolUse: (toolName) => {
                try { ws.send(JSON.stringify({ type: 'chat:tool', tool: toolName })); } catch { }
              },
              onStatus: (evt) => {
                try {
                  if (evt.type?.startsWith('code:')) {
                    ws.send(JSON.stringify(evt));
                  } else {
                    const { type: statusType, ...rest } = evt;
                    ws.send(JSON.stringify({ type: 'chat:status', status: statusType, ...rest }));
                  }
                } catch { }
              },
              // Acorn: forward tool calls to CLI client for local execution
              onToolExecute: isAcorn ? async (toolName, toolInput, toolId) => {
                ws.send(JSON.stringify({ type: 'tool:request', id: toolId, name: toolName, input: toolInput }));
                return new Promise((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    ws._pendingTools.delete(toolId);
                    reject(new Error(`Tool ${toolName} timed out (5min)`));
                  }, 300000);
                  ws._pendingTools.set(toolId, { resolve, reject, timeout });
                });
              } : undefined,
            });
            ws.send(JSON.stringify({
              type: 'chat:done',
              text: result.text,
              usage: result.usage,
              iterations: result.iterations,
              toolUsage: result.toolUsage,
            }));
            try {
              const feed = require('../graph/feed');
              feed.log({
                channelName: 'web:chat',
                userName: msg.userName || 'Operator',
                userMessage: msg.content,
                myResponse: result.text,
                trigger: 'dm',
                usage: result.usage,
                iterations: result.iterations,
              });
            } catch {}
          } catch (e) {
            const friendly = e.status === 529 || e.error?.type === 'overloaded_error' ? 'API is overloaded — try again in a moment'
              : e.status === 500 || e.error?.type === 'api_error' ? 'API server error — try again shortly'
                : e.status === 429 ? 'Rate limited — too many requests, wait a moment'
                  : (e.error?.error?.message || e.message || 'Unknown error').substring(0, 200);
            ws.send(JSON.stringify({ type: 'chat:error', error: friendly }));
          }
        } else if (msg.type === 'voice-chat') {
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Agent not available' }));
            return;
          }
          const sessionId = 'web:voice-call';
          try {
            ws.send(JSON.stringify({ type: 'voice:user-text', text: msg.content }));
            ws.send(JSON.stringify({ type: 'voice:thinking' }));
            const result = await this.tools._agent.processMessage({
              content: msg.content,
              channelId: sessionId, channelName: 'voice-call',
              userId: 'operator', userName: msg.userName || 'Operator',
              trigger: 'dm', platform: 'web', isDm: true,
              onTextDelta: (delta) => {
                try { ws.send(JSON.stringify({ type: 'voice:delta', text: delta })); } catch { }
              },
              onToolUse: (toolName) => {
                try { ws.send(JSON.stringify({ type: 'voice:tool', tool: toolName })); } catch { }
              },
            });
            const resp = {
              type: 'voice:response', transcription: null, text: result?.text,
              usage: result?.usage, toolUsage: result?.toolUsage, iterations: result?.iterations,
            };
            const pipeline = this._ensureVoicePipeline();
            if (pipeline && result?.text && result.text.trim() !== 'NO_REPLY') {
              try {
                const ttsResult = await pipeline.synthesizeOnly(result.text);
                if (ttsResult.audio) {
                  resp.audio = ttsResult.audio.toString('base64');
                  resp.audioMime = 'audio/mp3';
                }
              } catch (e) { this.log.warn('[voice-chat] TTS failed:', e.message); }
            }
            ws.send(JSON.stringify(resp));
            try {
              const feed = require('../graph/feed');
              feed.log({
                channelName: 'web:voice',
                userName: msg.userName || 'Operator',
                userMessage: msg.content,
                myResponse: result?.text,
                trigger: 'voice',
                usage: result?.usage,
                iterations: result?.iterations,
              });
            } catch {}
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }
        } else if (msg.type === 'voice') {
          const pipeline = this._ensureVoicePipeline();
          if (!pipeline) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Voice pipeline not configured (need TTS/STT keys)' }));
            return;
          }
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Agent not available' }));
            return;
          }
          try {
            const audioData = Buffer.from(msg.audio, 'base64');
            const mime = msg.mimeType || 'audio/webm';
            ws.send(JSON.stringify({ type: 'voice:transcribing' }));

            if (msg.mode === 'call') {
              const sessionId = 'web:voice-call';
              const sttFirst = await pipeline.transcribeOnly(audioData, mime);
              if (sttFirst.error || !sttFirst.text?.trim()) {
                if (sttFirst.error) ws.send(JSON.stringify({ type: 'voice:error', error: sttFirst.error }));
                return;
              }
              ws.send(JSON.stringify({ type: 'voice:user-text', text: sttFirst.text }));
              ws.send(JSON.stringify({ type: 'voice:thinking' }));
              const result = await pipeline.processFromText(sttFirst.text, this.tools._agent, {
                channelId: sessionId, channelName: 'voice-call',
                userId: 'operator', userName: msg.userName || 'Operator',
                trigger: 'dm', platform: 'web', isDm: true,
              });
              const resp = {
                type: 'voice:response', transcription: null, text: result.responseText,
                usage: result.usage, toolUsage: result.toolUsage, iterations: result.iterations,
              };
              if (result.audioBuffer) {
                resp.audio = result.audioBuffer.toString('base64');
                resp.audioMime = 'audio/mp3';
              }
              if (result.error) resp.error = result.error;
              ws.send(JSON.stringify(resp));
              try {
                const feed = require('../graph/feed');
                feed.log({
                  channelName: 'web:voice',
                  userName: msg.userName || 'Operator',
                  userMessage: sttFirst.text,
                  myResponse: result.responseText,
                  trigger: 'voice',
                  usage: result.usage,
                  iterations: result.iterations,
                });
              } catch {}
            } else if (msg.mode === 'interrupt-check') {
              const sttResult = await pipeline.transcribeOnly(audioData, mime);
              ws.send(JSON.stringify({ type: 'voice:interrupt-result', text: sttResult.text || '', error: sttResult.error }));
            } else {
              const sttResult = await pipeline.transcribeOnly(audioData, mime);
              if (sttResult.error) {
                ws.send(JSON.stringify({ type: 'voice:error', error: sttResult.error }));
                return;
              }
              ws.send(JSON.stringify({ type: 'voice:transcription', text: sttResult.text }));
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }
        } else if (msg.type === 'voice:tts') {
          const pipeline = this._ensureVoicePipeline();
          if (!pipeline) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Voice pipeline not configured' }));
            return;
          }
          try {
            const result = await pipeline.synthesizeOnly(msg.text);
            if (result.error || !result.audio) {
              ws.send(JSON.stringify({ type: 'voice:error', error: result.error || 'TTS returned no audio' }));
              return;
            }
            ws.send(JSON.stringify({
              type: 'voice:audio',
              audio: result.audio.toString('base64'),
              audioMime: 'audio/mp3',
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }

          // ── Terminal messages ──────────────────────────────────────────
        } else if (msg.type === 'terminal:open') {
          if (!ws._terminals) ws._terminals = new Map();
          this._handleTerminalOpen(ws, msg);
        } else if (msg.type === 'terminal:data') {
          this._handleTerminalData(ws, msg);
        } else if (msg.type === 'terminal:resize') {
          this._handleTerminalResize(ws, msg);
        } else if (msg.type === 'terminal:close') {
          this._handleTerminalClose(ws, msg);
        } else if (msg.type === 'terminal:hosts:list') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:hosts', hosts: [] })); return; }
          mgr.listHosts().then(hosts => ws.send(JSON.stringify({ type: 'terminal:hosts', hosts })));
        } else if (msg.type === 'terminal:hosts:save') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          mgr.saveHost(msg).then(result => ws.send(JSON.stringify({ type: 'terminal:hosts:saved', ...result })))
            .catch(e => ws.send(JSON.stringify({ type: 'terminal:hosts:saved', error: e.message })));
        } else if (msg.type === 'terminal:hosts:delete') {
          const mgr = this._ensureSSHManager();
          if (mgr) mgr.deleteHost(msg.id).then(() => ws.send(JSON.stringify({ type: 'terminal:hosts:deleted', id: msg.id })));
        } else if (msg.type === 'terminal:hosts:test') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          mgr.testConnection(msg.id).then(r => {
            ws.send(JSON.stringify({ type: 'terminal:hosts:tested', id: msg.id, ...r }));
          });
        } else if (msg.type === 'terminal:keystore:status') {
          const mgr = this._ensureSSHManager();
          ws.send(JSON.stringify({
            type: 'terminal:keystore:status',
            unlocked: mgr?.keystoreUnlocked || false,
            source: mgr?.keystoreSource || null,
          }));
        } else if (msg.type === 'terminal:keystore:unlock') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          try {
            mgr.unlockKeystore(msg.passphrase);
            ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: true }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: false, error: e.message }));
          }
        } else if (msg.type === 'terminal:keystore:lock') {
          const mgr = this._ensureSSHManager();
          if (mgr) mgr.lockKeystore();
          ws.send(JSON.stringify({ type: 'terminal:keystore:status', unlocked: false, source: null }));
        }
      });

      ws.on('close', () => {
        if (onGraphEvent) graphEvents.off('change', onGraphEvent);
        if (ws._terminals) {
          for (const [, sess] of ws._terminals) {
            if (sess.pty) { try { sess.pty.kill(); } catch { } }
            if (sess.sshId) { try { this._sshManager?.close(sess.sshId); } catch { } }
          }
          ws._terminals.clear();
        }
        this.log.info('[ws] Client disconnected from control panel');
      });
    });
  }

  // ── SSH Manager ─────────────────────────────────────────────────────

  _ensureSSHManager() {
    if (this._sshManager) return this._sshManager;
    if (this.tools?._sshManager) { this._sshManager = this.tools._sshManager; return this._sshManager; }
    try {
      const { SSHManager } = require('../tools/ssh-manager');
      this._sshManager = new SSHManager(this.config, this.log);
      return this._sshManager;
    } catch (e) {
      this.log.warn(`[ssh] SSHManager init failed: ${e.message}`);
      return null;
    }
  }

  // ── Terminal Handlers ───────────────────────────────────────────────

  _handleTerminalOpen(ws, msg) {
    const hostId = msg.hostId;
    const paneId = msg.paneId || 'default';

    const existing = ws._terminals?.get(paneId);
    if (existing) {
      existing._cancelled = true;
      if (existing.pty) { try { existing.pty.kill(); } catch { } }
      if (existing.sshId) { try { this._sshManager?.close(existing.sshId); } catch { } }
      ws._terminals.delete(paneId);
    }

    if (!hostId || hostId === 'local') {
      try {
        const pty = require('node-pty');
        const shell = process.env.SHELL || '/bin/bash';
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;
        const term = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: this.config.workspacePath || process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color', HOME: process.env.HOME || process.cwd() },
        });

        ws._terminals.set(paneId, { pty: term, sshId: null });
        this.log.info(`[terminal] Local PTY opened: pane=${paneId} pid=${term.pid}`);
        const mgr = this._ensureSSHManager();
        mgr?.audit(`local_${term.pid}`, 'pty_opened', { shell, paneId });

        term.onData((data) => {
          try { ws.send(JSON.stringify({ type: 'terminal:data', paneId, data })); } catch { }
        });

        term.onExit(({ exitCode }) => {
          ws._terminals?.delete(paneId);
          try { ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: `Shell exited (code ${exitCode})` })); } catch { }
        });

        ws.send(JSON.stringify({ type: 'terminal:opened', paneId, mode: 'local', pid: term.pid }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: `Failed to open local terminal: ${e.message}` }));
      }
    } else {
      const mgr = this._ensureSSHManager();
      if (!mgr) {
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: 'SSH manager not available' }));
        return;
      }

      const placeholder = { pty: null, sshId: null, _cancelled: false };
      ws._terminals.set(paneId, placeholder);

      const result = mgr.connect(hostId, {
        onReady: (sessionId) => {
          if (placeholder._cancelled) {
            try { this._sshManager?.close(sessionId); } catch { }
            this.log.info(`[terminal] SSH session ${sessionId} arrived for replaced pane=${paneId}, closing orphan`);
            return;
          }
          placeholder.sshId = sessionId;
          ws.send(JSON.stringify({ type: 'terminal:opened', paneId, mode: 'ssh', sessionId, hostId }));
          this.log.info(`[terminal] SSH session opened: pane=${paneId} session=${sessionId}`);
        },
        onData: (data) => {
          if (placeholder._cancelled) return;
          try { ws.send(JSON.stringify({ type: 'terminal:data', paneId, data })); } catch { }
        },
        onClose: () => {
          if (placeholder._cancelled) return;
          ws._terminals?.delete(paneId);
          try { ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: 'SSH connection closed' })); } catch { }
        },
        onError: (error) => {
          if (placeholder._cancelled) return;
          ws._terminals?.delete(paneId);
          ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: `SSH error: ${error}` }));
        },
      });

      if (result.error) {
        ws._terminals.delete(paneId);
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: result.error }));
      }
    }
  }

  _handleTerminalData(ws, msg) {
    const paneId = msg.paneId || 'default';
    const sess = ws._terminals?.get(paneId);
    if (!sess) return;
    if (sess.pty) {
      sess.pty.write(msg.data);
    } else if (sess.sshId && this._sshManager) {
      this._sshManager.write(sess.sshId, msg.data);
    }
  }

  _handleTerminalResize(ws, msg) {
    const paneId = msg.paneId || 'default';
    const cols = msg.cols || 80;
    const rows = msg.rows || 24;
    const sess = ws._terminals?.get(paneId);
    if (!sess) return;
    if (sess.pty) {
      sess.pty.resize(cols, rows);
    } else if (sess.sshId && this._sshManager) {
      this._sshManager.resize(sess.sshId, cols, rows);
    }
  }

  _handleTerminalClose(ws, msg) {
    const paneId = msg?.paneId || 'default';
    const sess = ws._terminals?.get(paneId);
    if (sess) {
      if (sess.pty) { try { sess.pty.kill(); } catch { } }
      if (sess.sshId && this._sshManager) { this._sshManager.close(sess.sshId); }
      ws._terminals.delete(paneId);
    }
    ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: 'Closed by user' }));
  }

  // ── Secure API Key Proxy ────────────────────────────────────────────

  _loadApiProxyConfig() {
    const workspace = this.config.workspacePath || process.cwd();
    const configPath = path.join(workspace, 'web', '.api-proxy.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config.routes || typeof config.routes !== 'object') return null;
      return config;
    } catch { return null; }
  }

  _matchProxyRoute(proxyRoute, config, req) {
    for (const [name, route] of Object.entries(config.routes)) {
      if (proxyRoute === name || proxyRoute.startsWith(name + '/')) {
        if (route.methods && !route.methods.includes(req.method)) continue;
        return { name, route, remainder: proxyRoute.slice(name.length) };
      }
    }
    return null;
  }

  async _fetchVaultKey(keyName) {
    const managerUrl = this.config.managerUrl;
    const serviceKey = this.config.managerServiceKey;
    if (!managerUrl || !serviceKey) return null;

    if (!this._vaultCache) this._vaultCache = new Map();
    const cached = this._vaultCache.get(keyName);
    if (cached && Date.now() - cached.ts < 300_000) return cached.value;

    try {
      const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
      const val = await new Promise((resolve) => {
        const req = http_.get(`${managerUrl}/api/vault/key?name=${encodeURIComponent(keyName)}`, {
          headers: { 'X-Service-Key': serviceKey, 'X-Anima-Id': this.config.agentId || 'unknown' },
          timeout: 5000,
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) { resolve(null); return; }
            try { resolve(JSON.parse(data).value || null); } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (val) this._vaultCache.set(keyName, { value: val, ts: Date.now() });
      return val;
    } catch { return null; }
  }

  async _handleApiProxy(req, res, matched, proxyRoute) {
    const { name, route, remainder } = matched;
    if (!route.target) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Proxy route "${name}" has no target URL` }));
      return;
    }

    try {
      const targetUrl = new URL(remainder || '/', route.target);

      // Forward query params from original request
      const origUrl = new URL(req.url, 'http://localhost');
      for (const [k, v] of origUrl.searchParams) targetUrl.searchParams.append(k, v);

      // Build headers: start with allowed incoming headers, then inject key headers
      const headers = {};
      const forwardHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding'];
      for (const h of forwardHeaders) { if (req.headers[h]) headers[h] = req.headers[h]; }

      // Inject API keys from vault or env vars — the core security feature
      if (route.headers && typeof route.headers === 'object') {
        for (const [headerName, headerVal] of Object.entries(route.headers)) {
          if (typeof headerVal === 'string' && headerVal.includes('$VAULT:')) {
            const vaultKeyName = headerVal.match(/\$VAULT:([A-Z_][A-Z0-9_]*)/)?.[1];
            if (!vaultKeyName) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Invalid $VAULT reference in proxy route "${name}"` }));
              return;
            }
            const vaultVal = await this._fetchVaultKey(vaultKeyName);
            if (!vaultVal) {
              const envFallback = process.env[vaultKeyName];
              if (!envFallback) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Vault key ${vaultKeyName} not found for proxy route "${name}"` }));
                return;
              }
              headers[headerName] = headerVal.replace(`$VAULT:${vaultKeyName}`, envFallback);
            } else {
              headers[headerName] = headerVal.replace(`$VAULT:${vaultKeyName}`, vaultVal);
            }
          } else if (typeof headerVal === 'string' && headerVal.startsWith('$')) {
            const envKey = headerVal.slice(1);
            const envVal = process.env[envKey];
            if (!envVal) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Env var ${envKey} not set for proxy route "${name}"` }));
              return;
            }
            headers[headerName] = envVal;
          } else {
            headers[headerName] = headerVal;
          }
        }
      }

      // Collect request body for non-GET
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => { chunks.push(c); if (chunks.reduce((s, b) => s + b.length, 0) > 5_000_000) reject(new Error('Body too large')); });
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      }

      const fetchOpts = { method: req.method, headers };
      if (body) fetchOpts.body = body;
      fetchOpts.signal = AbortSignal.timeout(route.timeout || 30000);

      const upstream = await fetch(targetUrl.toString(), fetchOpts);

      // Stream response back, stripping CORS (we control it)
      const respHeaders = {};
      for (const [k, v] of upstream.headers) {
        if (k.toLowerCase() !== 'access-control-allow-origin') respHeaders[k] = v;
      }
      respHeaders['access-control-allow-origin'] = '*';
      res.writeHead(upstream.status, respHeaders);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      } else {
        const buf = await upstream.arrayBuffer();
        res.end(Buffer.from(buf));
      }

      this.log.debug(`[api-proxy] ${req.method} ${name}${remainder} → ${upstream.status}`);
    } catch (e) {
      this.log.warn(`[api-proxy] Proxy error for "${name}": ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Proxy failed: ${e.message}` }));
      }
    }
  }

  // ── Graph API Handlers ──────────────────────────────────────────────

  async _handleMultiGraphApi(req, res, urlPath) {
    const registry = this.tools._graphRegistry;
    if (!registry) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Multi-graph registry not available' }));
      return;
    }

    const jsonBody = () => new Promise((resolve, reject) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 65536) { req.destroy(); reject(new Error('Too large')); } });
      req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    const jsonRes = (data, status = 200) => {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (urlPath === '/api/graphs' && req.method === 'GET') {
      const graphs = registry.list();
      return jsonRes({ graphs });
    }

    if (urlPath === '/api/graphs' && req.method === 'POST') {
      try {
        const { name, description } = await jsonBody();
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return jsonRes({ error: 'Name is required' }, 400);
        }
        const slug = registry.create(name.trim(), description || '');
        return jsonRes({ ok: true, slug, graph: registry.get(slug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    const match = urlPath.match(/^\/api\/graphs\/([a-z0-9-]+)(\/(.+))?$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const slug = match[1];
    const action = match[3] || null;

    if (action === 'activate' && req.method === 'POST') {
      try {
        const result = this.tools.switchGraph(slug);
        graphEvents.emit('change', { op: 'graph:switched', slug, source: 'multi-graph' });
        return jsonRes({ ok: true, ...result });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (action === 'duplicate' && req.method === 'POST') {
      try {
        const { name } = await jsonBody();
        if (!name) return jsonRes({ error: 'Name is required' }, 400);
        const newSlug = registry.duplicate(slug, name.trim());
        return jsonRes({ ok: true, slug: newSlug, graph: registry.get(newSlug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'PUT') {
      try {
        const { name, description } = await jsonBody();
        if (name) registry.rename(slug, name.trim());
        if (description !== undefined) registry.describe(slug, description);
        return jsonRes({ ok: true, graph: registry.get(slug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'DELETE') {
      try {
        registry.delete(slug);
        return jsonRes({ ok: true });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'GET') {
      const g = registry.get(slug);
      if (!g) return jsonRes({ error: 'Not found' }, 404);
      registry.refreshStats(slug);
      return jsonRes({ graph: { ...registry.get(slug), active: slug === registry.getActiveSlug() } });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown multi-graph endpoint' }));
  }

  _handleGraphApiOnWeb(req, res, urlPath, db) {
    if (!db) { res.writeHead(503); res.end(JSON.stringify({ error: 'Graph database not available' })); return; }

    const MAX_BODY = 1024 * 256;
    const json = () => new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; if (b.length > MAX_BODY) { req.destroy(); reject(new Error('Request body too large')); } }); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });

    if (urlPath === '/api/graph' && req.method === 'GET') {
      try {
        const nodes = db.prepare('SELECT * FROM nodes').all();
        const edges = db.prepare('SELECT source, target, type, weight FROM edges').all();
        const aspects = db.prepare('SELECT * FROM aspects').all();
        const attrs = db.prepare('SELECT * FROM attributes').all();
        const aliases = db.prepare('SELECT * FROM aliases').all();
        const attrsByAspect = {};
        for (const a of attrs) { (attrsByAspect[a.aspect_id] ||= []).push({ id: a.id, content: a.content, importance: a.importance, eventDate: a.event_date || null }); }
        const aspectsByNode = {};
        for (const a of aspects) { (aspectsByNode[a.node_id] ||= []).push({ id: a.id, name: a.name, weight: a.weight, attributes: attrsByAspect[a.id] || [] }); }
        const aliasesByNode = {};
        for (const a of aliases) { (aliasesByNode[a.node_id] ||= []).push(a.alias); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          nodes: nodes.map(n => ({ id: n.id, label: n.label, type: n.type, description: n.description || '', importance: n.importance, mentions: n.mentions || 0, aliases: aliasesByNode[n.id] || [], aspects: aspectsByNode[n.id] || [] })),
          edges: edges.map(e => ({ source: e.source, target: e.target, type: e.type, weight: e.weight || 1 })),
          meta: { nodeCount: nodes.length, edgeCount: edges.length },
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/tokens' && req.method === 'GET') {
      try {
        const feed = require('../graph/feed');
        const summary = feed.readTokenSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary || { error: 'No token data yet' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/graph/node' && req.method === 'POST') {
      json().then(data => {
        const { id, label, type, description, importance } = data;
        if (!id || !label || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'id, label, type required' })); return; }
        const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
        if (existing) db.prepare(`UPDATE nodes SET label=?, type=?, description=?, importance=?, updated=datetime('now') WHERE id=?`).run(label, type, description || '', importance || 5, id);
        else db.prepare('INSERT INTO nodes (id, label, type, description, importance, provenance) VALUES (?,?,?,?,?,?)').run(id, label, type, description || '', importance || 5, 'self');
        graphEvents.emit('change', { op: existing ? 'node:update' : 'node:create', node: { id, label, type, description: description || '' }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, id }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath.startsWith('/api/graph/node/') && req.method === 'DELETE') {
      const nodeId = decodeURIComponent(urlPath.split('/api/graph/node/')[1]);
      try {
        const edges = db.prepare('SELECT source, target, type FROM edges WHERE source = ? OR target = ?').all(nodeId, nodeId);
        db.prepare('DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = ?)').run(nodeId);
        db.prepare('DELETE FROM aspects WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(nodeId, nodeId);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
        for (const e of edges) { graphEvents.emit('change', { op: 'edge:delete', edge: e, source: 'editor' }); }
        graphEvents.emit('change', { op: 'node:delete', nodeId, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/graph/aspect' && req.method === 'POST') {
      json().then(data => {
        const { nodeId, name, weight, attributes } = data;
        if (!nodeId || !name) { res.writeHead(400); res.end(JSON.stringify({ error: 'nodeId, name required' })); return; }
        const existing = db.prepare('SELECT id FROM aspects WHERE node_id=? AND name=?').get(nodeId, name);
        if (existing) { db.prepare('DELETE FROM attributes WHERE aspect_id=?').run(existing.id); db.prepare('DELETE FROM aspects WHERE id=?').run(existing.id); }
        db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?,?,?,?)').run(nodeId, name, weight || 5, 'graph-viewer');
        const aspectId = db.prepare('SELECT id FROM aspects WHERE node_id=? AND name=? ORDER BY id DESC LIMIT 1').get(nodeId, name).id;
        if (attributes?.length) { const stmt = db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?,?,?,?,?)'); for (const a of attributes) stmt.run(aspectId, typeof a === 'string' ? a : a.content, a.importance || 5, 'graph-viewer', 'graph-viewer'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, aspectId }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath.startsWith('/api/graph/aspect/') && req.method === 'DELETE') {
      const aspectId = parseInt(urlPath.split('/api/graph/aspect/')[1]);
      try { db.prepare('DELETE FROM attributes WHERE aspect_id=?').run(aspectId); db.prepare('DELETE FROM aspects WHERE id=?').run(aspectId); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath.startsWith('/api/graph/attribute/') && req.method === 'DELETE') {
      const attrId = parseInt(urlPath.split('/api/graph/attribute/')[1]);
      try { db.prepare('DELETE FROM attributes WHERE id = ?').run(attrId); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath.startsWith('/api/graph/attribute/') && req.method === 'PUT') {
      const attrId = parseInt(urlPath.split('/api/graph/attribute/')[1]);
      json().then(data => {
        const { content, importance } = data;
        if (!content) { res.writeHead(400); res.end(JSON.stringify({ error: 'content required' })); return; }
        db.prepare('UPDATE attributes SET content = ?, importance = ? WHERE id = ?').run(content, importance || 5, attrId);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath === '/api/graph/edge' && req.method === 'POST') {
      json().then(data => {
        const { source, target, type, weight } = data;
        if (!source || !target || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'source, target, type required' })); return; }
        const existing = db.prepare('SELECT rowid FROM edges WHERE source=? AND target=? AND type=?').get(source, target, type);
        if (existing) db.prepare('UPDATE edges SET weight=? WHERE source=? AND target=? AND type=?').run(weight || 1, source, target, type);
        else db.prepare('INSERT INTO edges (source, target, type, weight) VALUES (?,?,?,?)').run(source, target, type, weight || 1);
        graphEvents.emit('change', { op: existing ? 'edge:update' : 'edge:create', edge: { source, target, type }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath === '/api/graph/edge' && req.method === 'DELETE') {
      json().then(data => {
        const { source, target, type } = data;
        db.prepare('DELETE FROM edges WHERE source=? AND target=? AND type=?').run(source, target, type);
        graphEvents.emit('change', { op: 'edge:delete', edge: { source, target, type }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  }
}

module.exports = { WebGateway };
