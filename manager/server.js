/**
 * Anima Manager — Secure web-based management for all agent instances.
 *
 * Security: multi-user session auth, CSRF tokens, rate limiting, strict path
 * validation, input sanitization, secure headers. No Docker socket by default.
 *
 * Users: stored in ANIMAS_DIR/.anima-users.json (hidden from agent listing).
 * Roles: 'super' (manage all agents + users), 'user' (own agents only).
 * Bootstrap: on first run, creates a super user from MANAGER_USER/MANAGER_PASS.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const brandPath = [path.join(__dirname, 'brand.json'), path.join(__dirname, '..', 'brand.json')]
  .find(p => fs.existsSync(p)) || path.join(__dirname, '..', 'brand.json');
const brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));

// ── Config ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MANAGER_PORT || '18900', 10);
const ANIMAS_DIR = process.env.ANIMAS_DIR || path.join(__dirname, '..', 'animas');
const MANAGER_USER = process.env.MANAGER_USER || 'admin';
const MANAGER_PASS = process.env.MANAGER_PASS || '';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;   // 15 min
const RATE_LIMIT_MAX = 5;
const RESTART_MARKER = '.restart';
const COOKIE_PATH = process.env.MANAGER_BASE_PATH || '/';
const DEFAULTS_FILE = path.join(__dirname, 'defaults.env');
const MANAGER_SERVICE_KEY = process.env.MANAGER_SERVICE_KEY || '';
const USERS_FILE = () => path.join(ANIMAS_DIR, '.anima-users.json');
const AUTH_CONFIG_FILE = () => path.join(ANIMAS_DIR, '.auth-config.json');
const VAULT_DB_PATH = path.join(ANIMAS_DIR, '.vault.db');
const VAULT_KEY_FILE = path.join(ANIMAS_DIR, '.vault-key');
const SHARED_DIR = process.env.SHARED_DIR || path.join(__dirname, '..', 'shared');
const SHARED_GRAPHS_DIR = path.join(SHARED_DIR, 'graphs');
const PROJECTS_REGISTRY = path.join(SHARED_GRAPHS_DIR, '_projects.json');
const INGRESS_FILE = path.join(ANIMAS_DIR, '.ingress.json');

function readIngress() {
  try { return JSON.parse(fs.readFileSync(INGRESS_FILE, 'utf8')); }
  catch { return { domain: '', https: false, email: '', httpPort: 18000 }; }
}

// ── Cloudflare Quick Tunnel state ──────────────────────────────────
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelError = null;

function writeIngress(obj) {
  fs.writeFileSync(INGRESS_FILE, JSON.stringify(obj) + '\n');
}

// Bare mode: no Docker — agents run as direct Node.js processes
const BARE_MODE = (() => {
  if (process.env.ANIMA_BARE_MODE === 'true') return true;
  if (process.env.ANIMA_BARE_MODE === 'false') return false;
  // If we're running inside a container, we're in Docker mode even without the docker CLI
  if (fs.existsSync('/.dockerenv') || (function () {
    try { return fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'); } catch { return false; }
  })()) return false;
  try { require('child_process').execSync('docker --version', { stdio: 'ignore' }); return false; } catch { return true; }
})();
const SRC_DIR = path.resolve(ANIMAS_DIR, '..', 'src');

if (!MANAGER_PASS) {
  console.error('[manager] FATAL: MANAGER_PASS is not set. Set it in manager/.env');
  process.exit(1);
}

// ── Shared Project Graphs ───────────────────────────────────────────

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_REGISTRY)) return JSON.parse(fs.readFileSync(PROJECTS_REGISTRY, 'utf8'));
  } catch {}
  return {};
}

function saveProjects(projects) {
  fs.mkdirSync(SHARED_GRAPHS_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_REGISTRY, JSON.stringify(projects, null, 2) + '\n');
  try { fs.chmodSync(SHARED_GRAPHS_DIR, 0o2775); } catch {}
}

function seedProjectGraph(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const seedSql = path.join(__dirname, '..', 'src', 'seed-graph.sql');
  const seedSqlAlt = '/anima-base-src/seed-graph.sql';
  const seedPath = fs.existsSync(seedSql) ? seedSql : (fs.existsSync(seedSqlAlt) ? seedSqlAlt : null);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  if (seedPath) {
    const sql = fs.readFileSync(seedPath, 'utf8');
    const schemaOnly = sql.split(/^INSERT /m)[0];
    db.exec(schemaOnly.trim());
  }
  db.close();
}

// ── Credential Vault ────────────────────────────────────────────────
//
// AES-256-GCM encrypted SQLite store for API keys. The encryption master key
// is read from VAULT_ENCRYPTION_KEY env or auto-generated to .vault-key file.

function getVaultEncryptionKey() {
  const envKey = process.env.VAULT_ENCRYPTION_KEY;
  if (envKey && envKey.length >= 32) return Buffer.from(envKey.slice(0, 32), 'utf8');
  if (envKey) return crypto.createHash('sha256').update(envKey).digest();
  try {
    if (fs.existsSync(VAULT_KEY_FILE)) {
      return Buffer.from(fs.readFileSync(VAULT_KEY_FILE, 'utf8').trim(), 'hex');
    }
  } catch {}
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(VAULT_KEY_FILE, key.toString('hex'), { mode: 0o600 }); } catch {}
  return key;
}

const VAULT_KEY = getVaultEncryptionKey();

function vaultEncrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), encrypted: enc.toString('hex'), tag: tag.toString('hex') };
}

function vaultDecrypt(encrypted, ivHex, tagHex) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encrypted, 'hex'), null, 'utf8') + decipher.final('utf8');
}

let _vaultDb;
function getVaultDb() {
  if (_vaultDb) return _vaultDb;
  const { DatabaseSync } = require('node:sqlite');
  _vaultDb = new DatabaseSync(VAULT_DB_PATH);
  _vaultDb.exec(`
    CREATE TABLE IF NOT EXISTS vault_keys (
      name TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vault_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      key_name TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS llm_providers (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      encrypted_key TEXT DEFAULT '',
      iv TEXT DEFAULT '',
      auth_tag TEXT DEFAULT '',
      auth_header TEXT NOT NULL DEFAULT 'bearer',
      vision_models TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'global',
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: vision (INTEGER) → vision_models (TEXT)
  try {
    const cols = _vaultDb.prepare("PRAGMA table_info(llm_providers)").all().map(c => c.name);
    if (cols.includes('vision') && !cols.includes('vision_models')) {
      _vaultDb.exec(`ALTER TABLE llm_providers ADD COLUMN vision_models TEXT NOT NULL DEFAULT ''`);
      _vaultDb.exec(`UPDATE llm_providers SET vision_models = '*' WHERE vision = 1`);
    }
  } catch {}

  return _vaultDb;
}

function vaultSet(name, value, scope = 'global', description = '') {
  const db = getVaultDb();
  const { iv, encrypted, tag } = vaultEncrypt(value);
  db.prepare(`INSERT OR REPLACE INTO vault_keys (name, encrypted_value, iv, auth_tag, scope, description, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(name, encrypted, iv, tag, scope, description);
  return true;
}

function vaultGet(name) {
  const db = getVaultDb();
  const row = db.prepare('SELECT * FROM vault_keys WHERE name = ?').get(name);
  if (!row) return null;
  try {
    const value = vaultDecrypt(row.encrypted_value, row.iv, row.auth_tag);
    return { name: row.name, value, scope: row.scope, description: row.description };
  } catch {
    return null;
  }
}

function vaultList() {
  const db = getVaultDb();
  return db.prepare('SELECT name, scope, description, created_at, updated_at FROM vault_keys ORDER BY name').all();
}

function vaultDelete(name) {
  const db = getVaultDb();
  const info = db.prepare('DELETE FROM vault_keys WHERE name = ?').run(name);
  return info.changes > 0;
}

function vaultLog(action, keyName, actor, actorType = 'user') {
  try {
    const db = getVaultDb();
    db.prepare('INSERT INTO vault_log (action, key_name, actor, actor_type) VALUES (?, ?, ?, ?)').run(action, keyName, actor, actorType);
  } catch {}
}

// ── LLM Provider helpers ─────────────────────────────────────────

function providerSet(name, { url, key, authHeader, scope, description }) {
  const db = getVaultDb();
  let encKey = '', iv = '', tag = '';
  if (key) {
    const enc = vaultEncrypt(key);
    encKey = enc.encrypted; iv = enc.iv; tag = enc.tag;
  } else {
    const existing = db.prepare('SELECT encrypted_key, iv, auth_tag FROM llm_providers WHERE name = ?').get(name);
    if (existing) { encKey = existing.encrypted_key || ''; iv = existing.iv || ''; tag = existing.auth_tag || ''; }
  }
  db.prepare(`INSERT OR REPLACE INTO llm_providers
    (name, url, encrypted_key, iv, auth_tag, auth_header, scope, description, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(name, url, encKey, iv, tag, authHeader || 'bearer', scope || 'global', description || '');
  return true;
}

function providerGet(name) {
  const db = getVaultDb();
  const row = db.prepare('SELECT * FROM llm_providers WHERE name = ?').get(name);
  if (!row) return null;
  let key = '';
  if (row.encrypted_key && row.iv) {
    try { key = vaultDecrypt(row.encrypted_key, row.iv, row.auth_tag); } catch {}
  }
  return { name: row.name, url: row.url, key, authHeader: row.auth_header, scope: row.scope, description: row.description };
}

function providerList() {
  const db = getVaultDb();
  return db.prepare('SELECT name, url, auth_header, scope, description, created_at, updated_at FROM llm_providers ORDER BY name').all();
}

function providerDelete(name) {
  const db = getVaultDb();
  const info = db.prepare('DELETE FROM llm_providers WHERE name = ?').run(name);
  return info.changes > 0;
}

function providerConfigForAnima(animaId) {
  const db = getVaultDb();
  const rows = db.prepare('SELECT * FROM llm_providers ORDER BY name').all();
  const result = {};
  for (const row of rows) {
    const scopes = (row.scope || 'global').split(',').map(s => s.trim());
    if (!scopes.includes('global') && !scopes.includes(animaId)) continue;
    let key = '';
    if (row.encrypted_key && row.iv) {
      try { key = vaultDecrypt(row.encrypted_key, row.iv, row.auth_tag); } catch {}
    }
    result[row.name] = { name: row.name, url: row.url, key, authHeader: row.auth_header };
  }
  return result;
}

function verifyServiceKey(req) {
  const svcKey = req.headers['x-service-key'];
  return MANAGER_SERVICE_KEY && svcKey
    && svcKey.length === MANAGER_SERVICE_KEY.length
    && crypto.timingSafeEqual(Buffer.from(svcKey), Buffer.from(MANAGER_SERVICE_KEY));
}

const vaultRateLimits = new Map();

// ── Multi-user Auth ──────────────────────────────────────────────────

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, salt, storedHash) {
  const computed = hashPassword(password, salt);
  if (computed.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

function loadUsers() {
  const file = USERS_FILE();
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return [];
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE(), JSON.stringify(users, null, 2) + '\n');
}

function findUser(username) {
  return loadUsers().find(u => u.username === username) || null;
}

// Bootstrap: create initial super user from env vars if no users exist yet
function bootstrapUsers() {
  const file = USERS_FILE();
  try {
    if (fs.existsSync(file)) {
      const users = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (users.length > 0) return;
    }
  } catch {}
  const { salt, hash } = createPasswordHash(MANAGER_PASS);
  const users = [{
    username: MANAGER_USER,
    salt,
    hash,
    role: 'super',
    createdAt: new Date().toISOString(),
  }];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    saveUsers(users);
    console.log(`[manager] Bootstrapped super user: ${MANAGER_USER}`);
  } catch (e) {
    console.error('[manager] Could not write users file:', e.message);
  }
}

// ── Auth Config (Google OAuth) ───────────────────────────────────────

const DEFAULT_AUTH_CONFIG = { google: { enabled: false, clientId: '', clientSecret: '', allowedDomain: '', allowedEmails: [], autoCreateUsers: true } };

function loadAuthConfig() {
  const file = AUTH_CONFIG_FILE();
  try {
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...DEFAULT_AUTH_CONFIG, google: { ...DEFAULT_AUTH_CONFIG.google, ...cfg.google } };
    }
  } catch {}
  return { ...DEFAULT_AUTH_CONFIG };
}

function saveAuthConfig(config) {
  fs.writeFileSync(AUTH_CONFIG_FILE(), JSON.stringify(config, null, 2) + '\n');
}

// Short-lived OAuth state nonces (CSRF protection for the OAuth flow)
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of oauthStates) {
    if (now - data.created > 5 * 60 * 1000) oauthStates.delete(state);
  }
}, 30_000);

function googleHttpsRequest(url, options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Google API timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function isEmailAllowed(email, config) {
  const g = config.google;
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  if (g.allowedDomain && domain === g.allowedDomain.toLowerCase()) return true;
  if (g.allowedEmails?.some(e => e.toLowerCase() === email.toLowerCase())) return true;
  if (!g.allowedDomain && (!g.allowedEmails || g.allowedEmails.length === 0)) return true;
  return false;
}

function getExternalPrefix(req) {
  return (req.headers['x-forwarded-prefix'] || process.env.MANAGER_BASE_PATH || '').replace(/\/+$/, '');
}

function isSecureRequest(req) {
  if (process.env.MANAGER_SECURE_COOKIE === 'true') return true;
  if (process.env.MANAGER_SECURE_COOKIE === 'false') return false;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function getRedirectUri(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${getExternalPrefix(req)}/api/auth/google/callback`;
}

function oauthRedirect(req, res, errorOrPath) {
  const prefix = getExternalPrefix(req);
  const location = errorOrPath ? `${prefix}/?error=${encodeURIComponent(errorOrPath)}` : `${prefix}/`;
  res.writeHead(302, { Location: location });
  res.end();
}

// ── Sessions ─────────────────────────────────────────────────────────

const sessions = new Map();
const loginAttempts = new Map();

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { csrf, created: Date.now(), username, role });
  return { token, csrf };
}

function validateSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map(c => c.trim());
  const sessionCookie = cookie.find(c => c.startsWith('manager_session='));
  if (!sessionCookie) return null;
  const token = sessionCookie.split('=')[1];
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function validateCSRF(req, session) {
  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfHeader || !session.csrf) return false;
  if (csrfHeader.length !== session.csrf.length) return false;
  return crypto.timingSafeEqual(Buffer.from(csrfHeader), Buffer.from(session.csrf));
}

// Evict expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.created > SESSION_TTL_MS) sessions.delete(token);
  }
}, 60_000);

// ── Rate Limiting ────────────────────────────────────────────────────

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) loginAttempts.delete(ip);
  }
}, 60_000);

// ── Path Validation ──────────────────────────────────────────────────

function validateAnimaId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.startsWith('.') || id.includes('/') || id.includes('\\')) return false;
  if (id.includes('..') || id.includes('\0')) return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

function getAnimaDir(id) {
  if (!validateAnimaId(id)) return null;
  const dir = path.join(ANIMAS_DIR, id);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(ANIMAS_DIR) + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

// ── .env Parsing ─────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  'DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY',
  'XI_API_KEY', 'OPENAI_API_KEY', 'BRAVE_API_KEY', 'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN', 'ANIMA_WEB_AUTH_PASS', 'REPLICATE_API_TOKEN',
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
]);

function parseEnvFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return {};
  } catch { return {}; }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1);
    env[key] = value;
  }
  return env;
}

function resolveGraphDb(animaDir) {
  const activePath = path.join(animaDir, 'data', 'graphs', '_active');
  try {
    const active = fs.readFileSync(activePath, 'utf8').trim();
    if (active) {
      const dbPath = path.join(animaDir, 'data', 'graphs', `${active}.db`);
      if (fs.existsSync(dbPath)) return dbPath;
    }
  } catch {}
  const legacy = path.join(animaDir, 'data', 'graph.db');
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function maskSensitive(env) {
  const masked = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_KEYS.has(key) && value && value.length > 8) {
      masked[key] = value.slice(0, 6) + '...' + value.slice(-4);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

// Keys that make sense to share as defaults (no per-agent tokens)
const ALLOWED_DEFAULT_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'BRAVE_API_KEY', 'GEMINI_API_KEY', 'REPLICATE_API_TOKEN',
  'OPENAI_API_KEY', 'XI_API_KEY', 'DEEPGRAM_API_KEY',
  'ANIMA_MODEL', 'ANIMA_CASUAL_MODEL', 'ANIMA_NORMAL_MODEL', 'ANIMA_PLANNER_MODEL',
  'ANIMA_LEARNER_MODEL', 'ANIMA_SUBAGENT_MODEL', 'ANIMA_VISION_MODEL',
  'ANIMA_STT_PROVIDER', 'ANIMA_TTS_PROVIDER', 'ANIMA_TTS_EDGE_VOICE',
  'ANIMA_LEARNING_MODE', 'ANIMA_CONTEXT_WINDOW', 'ANIMA_COMPACT_THRESHOLD',
  'ANIMA_COMPACT_KEEP_TAIL', 'ANIMA_MAINTAINER_IDLE_ONLY',
  'LOCAL_MODEL_BASE_URL', 'LOCAL_MODEL_API_KEY',
]);

const ALLOWED_ENV_KEYS = new Set([
  'DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'AGENT_ID', 'ANIMA_DISPLAY_NAME',
  'ANIMA_MODEL', 'ANIMA_CASUAL_MODEL', 'ANIMA_NORMAL_MODEL', 'ANIMA_PLANNER_MODEL',
  'ANIMA_HEALTH_PORT', 'ANIMA_LOG_LEVEL', 'GRAPH_DB_PATH',
  'SESSION_DB_PATH', 'BRAVE_API_KEY', 'GEMINI_API_KEY', 'REPLICATE_API_TOKEN',
  'XI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'ANIMA_WEB_PORT', 'ANIMA_WEB_AUTH_USER',
  'ANIMA_WEB_AUTH_PASS', 'ANIMA_PERSONALITY_EDITABLE',
  'ANIMA_SRC_EDITABLE', 'ANIMA_NICKNAMES',
  'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'ANIMA_VOICE_ENABLED',
  'ANIMA_STT_PROVIDER', 'ANIMA_TTS_PROVIDER', 'ANIMA_TTS_VOICE',
  'ANIMA_TTS_MODEL', 'ANIMA_TTS_SPEED', 'ANIMA_TTS_EDGE_VOICE',
  'ANIMA_LEARNER_MODEL', 'ANIMA_SUBAGENT_MODEL', 'ANIMA_HEARTBEAT_MINUTES',
  'ANIMA_DEBOUNCE_MS', 'ANIMA_WORKSPACE_PATH',
  'ANIMA_LEARNING_MODE', 'ANIMA_CONTEXT_WINDOW', 'ANIMA_COMPACT_THRESHOLD',
  'ANIMA_COMPACT_KEEP_TAIL', 'ANIMA_MAINTAINER_IDLE_ONLY',
  'LOCAL_MODEL_BASE_URL', 'LOCAL_MODEL_API_KEY',
  'ANIMA_PROACTIVE_ENABLED', 'ANIMA_PROACTIVE_COOLDOWN',
  'ANIMA_PROACTIVE_MAX_DAY', 'ANIMA_PROACTIVE_CHANNELS',
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
  'ANIMA_OWNER',
  'MANAGER_URL', 'MANAGER_SERVICE_KEY', 'ANIMA_PUBLIC_URL',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_REFERER',
]);

function validateEnvValue(value) {
  if (typeof value !== 'string') return false;
  if (value.length > 2048) return false;
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) return false;
  return true;
}

function isAllowedEnvKey(key) {
  if (ALLOWED_ENV_KEYS.has(key)) return true;
  if (/^[A-Z][A-Z0-9_]*_(API_KEY|API_TOKEN|SECRET|TOKEN)$/.test(key)) return true;
  if (/^CUSTOM_[A-Z0-9_]+$/.test(key)) return true;
  return false;
}

function writeEnvFile(filePath, env) {
  const lines = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isAllowedEnvKey(key)) continue;
    if (!validateEnvValue(value)) continue;
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > maxBytes) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' wss: ws:; form-action 'self' https://accounts.google.com;");
}

function getClientIP(req) {
  // Use socket address for rate limiting — X-Forwarded-For is spoofable
  // unless we're behind a trusted reverse proxy (Traefik) on Docker network.
  return req.socket.remoteAddress || '0.0.0.0';
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── List Animas ──────────────────────────────────────────────────────

function listAnimas(session) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(ANIMAS_DIR); } catch { return results; }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = path.join(ANIMAS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    const envPath = path.join(dir, '.env');
    const configPath = path.join(dir, 'anima.json');
    const env = parseEnvFile(envPath);

    const owner = env.ANIMA_OWNER || null;

    // Regular users only see animas they own; super users see everything
    if (session && session.role !== 'super') {
      if (owner !== session.username) continue;
    }

    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

    const stopped = fs.existsSync(path.join(dir, '.stopped'));

    let buildStatus = null;
    try {
      const bsPath = path.join(dir, '.build-status.json');
      if (fs.existsSync(bsPath)) buildStatus = JSON.parse(fs.readFileSync(bsPath, 'utf8'));
    } catch {}

    results.push({
      id: name,
      displayName: config.displayName || env.ANIMA_DISPLAY_NAME || name,
      healthPort: parseInt(env.ANIMA_HEALTH_PORT || '0', 10),
      webPort: parseInt(env.ANIMA_WEB_PORT || '0', 10),
      ingressDomain: env.ANIMA_INGRESS_DOMAIN || null,
      ingressPath: env.ANIMA_INGRESS_PATH || null,
      ingressHttps: env.ANIMA_INGRESS_HTTPS === 'true',
      telegram: !!(env.TELEGRAM_BOT_TOKEN),
      discord: !!(env.DISCORD_TOKEN),
      slack: !!(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN),
      voiceEnabled: env.ANIMA_VOICE_ENABLED === 'true' || !!(env.DEEPGRAM_API_KEY),
      ttsProvider: env.ANIMA_TTS_PROVIDER || (env.XI_API_KEY ? 'elevenlabs' : 'edge'),
      owner,
      stopped,
      buildStatus,
    });
  }

  return results;
}

// ── Health Check Proxy ───────────────────────────────────────────────

function proxyHealth(animaId) {
  const dir = getAnimaDir(animaId);
  if (!dir) return Promise.resolve({ status: 'unknown', error: 'not found' });
  const env = parseEnvFile(path.join(dir, '.env'));
  const port = parseInt(env.ANIMA_HEALTH_PORT || '18790', 10);

  // In bare mode only localhost is reachable; in Docker try container name first
  const urls = BARE_MODE
    ? [`http://127.0.0.1:${port}/health`]
    : [`http://${animaId}:${port}/health`, `http://127.0.0.1:${port}/health`];

  return tryHealthUrls(urls, 0);
}

function proxyTokens(animaId, animaDir) {
  const env = parseEnvFile(path.join(animaDir, '.env'));
  const webPort = parseInt(env.ANIMA_WEB_PORT || '0', 10);
  if (!webPort) return Promise.resolve({ error: 'Web server not configured for this anima' });

  const serviceKey = env.MANAGER_SERVICE_KEY || '';

  const urls = [
    { host: animaId,    port: webPort },
    { host: '127.0.0.1', port: webPort },
  ];

  return tryTokenUrls(urls, 0, serviceKey);
}

function tryTokenUrls(urls, idx, serviceKey) {
  if (idx >= urls.length) return Promise.resolve({ error: 'Token data unavailable' });
  const { host, port } = urls[idx];
  const headers = {};
  if (serviceKey) headers['x-service-key'] = serviceKey;
  const reqOpts = {
    hostname: host, port, path: '/api/tokens', method: 'GET', timeout: 3000,
    headers,
  };
  return new Promise((resolve) => {
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid response from anima' }); }
      });
    });
    req.on('error', () => resolve(tryTokenUrls(urls, idx + 1, serviceKey)));
    req.on('timeout', () => { req.destroy(); resolve(tryTokenUrls(urls, idx + 1, serviceKey)); });
    req.end();
  });
}

function tryHealthUrls(urls, idx) {
  if (idx >= urls.length) return Promise.resolve({ status: 'down' });
  return new Promise((resolve) => {
    const req = http.get(urls[idx], { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'up', raw: data }); }
      });
    });
    req.on('error', () => resolve(tryHealthUrls(urls, idx + 1)));
    req.on('timeout', () => { req.destroy(); resolve(tryHealthUrls(urls, idx + 1)); });
  });
}

// ── Router ───────────────────────────────────────────────────────────

const STATIC_DIR = path.join(__dirname, 'static');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

async function handleRequest(req, res) {
  secureHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // ── Uploaded files (chatroom) ─────────────────────────────────────
  if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
    const safeName = path.normalize(pathname.replace('/uploads/', '')).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(UPLOADS_DIR, safeName);
    if (!fullPath.startsWith(UPLOADS_DIR + path.sep) && fullPath !== UPLOADS_DIR) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(fullPath));
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // ── Static files ──────────────────────────────────────────────────
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    const filePath = pathname === '/' ? '/index.html' : pathname;
    const safeName = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(STATIC_DIR, safeName);

    if (!fullPath.startsWith(STATIC_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      let content = fs.readFileSync(fullPath);
      if (ext === '.html') {
        const brandJs = path.join(STATIC_DIR, 'brand.js');
        if (fs.existsSync(brandJs)) {
          const brandScript = `<script>\n${fs.readFileSync(brandJs, 'utf8')}\n</script>`;
          content = content.toString().replace(/<script id="brand-loader">[\s\S]*?<\/script>/, brandScript);
        }
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
      return;
    }
    // SPA fallback
    const indexPath = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, 'utf8');
      const brandJs = path.join(STATIC_DIR, 'brand.js');
      if (fs.existsSync(brandJs)) {
        const brandScript = `<script>\n${fs.readFileSync(brandJs, 'utf8')}\n</script>`;
        html = html.replace(/<script id="brand-loader">[\s\S]*?<\/script>/, brandScript);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // ── Auth: Login ───────────────────────────────────────────────────
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const ip = getClientIP(req);
    if (!checkRateLimit(ip)) {
      return json(res, { error: 'Too many login attempts. Try again later.' }, 429);
    }
    try {
      const body = await readBody(req);
      const user = findUser(body.username);
      if (user && verifyPassword(body.password, user.salt, user.hash)) {
        const { token, csrf } = createSession(user.username, user.role);
        const secureSuffix = isSecureRequest(req) ? '; Secure' : '';
        res.setHeader('Set-Cookie', `manager_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureSuffix}`);
        return json(res, { ok: true, csrf, role: user.role });
      }
      return json(res, { error: 'Invalid credentials' }, 401);
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  }

  // ── Auth: Logout ──────────────────────────────────────────────────
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = validateSession(req);
    if (session) sessions.delete(session.token);
    const secureSuffix = isSecureRequest(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `manager_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureSuffix}`);
    return json(res, { ok: true });
  }

  // ── Auth: Check ───────────────────────────────────────────────────
  if (pathname === '/api/auth/check' && req.method === 'GET') {
    const session = validateSession(req);
    return json(res, {
      authenticated: !!session,
      csrf: session?.csrf || null,
      username: session?.username || null,
      role: session?.role || null,
    });
  }

  // ── Auth: Verify Access (container-to-container SSO) ──────────────
  if (pathname === '/api/auth/verify-access' && req.method === 'POST') {
    const svcKey = req.headers['x-service-key'];
    const svcOk = MANAGER_SERVICE_KEY && svcKey
      && svcKey.length === MANAGER_SERVICE_KEY.length
      && crypto.timingSafeEqual(Buffer.from(svcKey), Buffer.from(MANAGER_SERVICE_KEY));
    if (!svcOk) return json(res, { error: 'Forbidden' }, 403);
    try {
      const body = await readBody(req);
      const { username, password, animaId } = body;
      if (!username || !password) return json(res, { error: 'Missing credentials' }, 400);
      const user = findUser(username);
      if (!user || !verifyPassword(password, user.salt, user.hash)) {
        return json(res, { error: 'Invalid credentials' }, 401);
      }
      if (user.role !== 'super' && animaId) {
        const animaDir = getAnimaDir(animaId);
        if (animaDir) {
          const env = parseEnvFile(path.join(animaDir, '.env'));
          if (env.ANIMA_OWNER && env.ANIMA_OWNER !== username) {
            return json(res, { error: 'Access denied to this anima' }, 403);
          }
        }
      }
      return json(res, { ok: true, role: user.role, username: user.username });
    } catch (e) { return json(res, { error: e.message }, 400); }
  }

  // ── Auth: Verify Session Token (container-to-container SSO) ──────
  if (pathname === '/api/auth/verify-session' && req.method === 'POST') {
    const svcKey = req.headers['x-service-key'];
    const svcOk = MANAGER_SERVICE_KEY && svcKey
      && svcKey.length === MANAGER_SERVICE_KEY.length
      && crypto.timingSafeEqual(Buffer.from(svcKey), Buffer.from(MANAGER_SERVICE_KEY));
    if (!svcOk) return json(res, { error: 'Forbidden' }, 403);
    try {
      const body = await readBody(req);
      const { token, animaId } = body;
      if (!token) return json(res, { error: 'Missing token' }, 400);
      const sess = sessions.get(token);
      if (!sess || Date.now() - sess.created > SESSION_TTL_MS) {
        return json(res, { ok: false }, 200);
      }
      if (animaId && sess.role !== 'super' && !body.webappOnly) {
        const animaDir = getAnimaDir(animaId);
        if (animaDir) {
          const env = parseEnvFile(path.join(animaDir, '.env'));
          if (env.ANIMA_OWNER && env.ANIMA_OWNER !== sess.username) {
            return json(res, { ok: false }, 200);
          }
        }
      }
      return json(res, { ok: true, username: sess.username, role: sess.role });
    } catch (e) { return json(res, { error: e.message }, 400); }
  }

  // ── Google OAuth: public status (is Google Auth enabled?) ─────────
  if (pathname === '/api/auth/google/status' && req.method === 'GET') {
    const cfg = loadAuthConfig();
    return json(res, { enabled: !!cfg.google.enabled && !!cfg.google.clientId });
  }

  // ── Google OAuth: initiate flow ───────────────────────────────────
  if (pathname === '/api/auth/google' && req.method === 'GET') {
    const cfg = loadAuthConfig();
    if (!cfg.google.enabled || !cfg.google.clientId) {
      oauthRedirect(req, res, 'google_not_configured'); return;
    }
    const state = crypto.randomBytes(24).toString('hex');
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const returnTo = reqUrl.searchParams.get('returnTo') || '';
    oauthStates.set(state, { created: Date.now(), returnTo });
    const redirectUri = getRedirectUri(req);
    const params = new URLSearchParams({
      client_id: cfg.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      state,
      prompt: 'select_account',
    });
    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    res.end(); return;
  }

  // ── Google OAuth: callback ────────────────────────────────────────
  if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) { oauthRedirect(req, res, error); return; }
    if (!state || !oauthStates.has(state)) { oauthRedirect(req, res, 'invalid_state'); return; }
    const oauthState = oauthStates.get(state);
    oauthStates.delete(state);

    if (!code) { oauthRedirect(req, res, 'no_code'); return; }

    const cfg = loadAuthConfig();
    if (!cfg.google.enabled || !cfg.google.clientId || !cfg.google.clientSecret) {
      oauthRedirect(req, res, 'google_not_configured'); return;
    }

    try {
      const redirectUri = getRedirectUri(req);
      const tokenBody = new URLSearchParams({
        code,
        client_id: cfg.google.clientId,
        client_secret: cfg.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString();

      const tokenResp = await googleHttpsRequest('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) },
      }, tokenBody);

      if (tokenResp.status !== 200 || !tokenResp.data.access_token) {
        console.error('[manager] Google token exchange failed:', tokenResp.data);
        oauthRedirect(req, res, 'token_exchange_failed'); return;
      }

      const userResp = await googleHttpsRequest('https://www.googleapis.com/oauth2/v2/userinfo', {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenResp.data.access_token}` },
      });

      if (userResp.status !== 200 || !userResp.data.email) {
        console.error('[manager] Google userinfo failed:', userResp.data);
        oauthRedirect(req, res, 'userinfo_failed'); return;
      }

      const { email, name, hd } = userResp.data;
      const emailLower = email.toLowerCase();

      if (!isEmailAllowed(emailLower, cfg)) {
        console.log(`[manager] Google sign-in denied for ${emailLower} (not in allowlist)`);
        oauthRedirect(req, res, 'access_denied'); return;
      }

      // Find or create user
      const users = loadUsers();
      let user = users.find(u => u.username === emailLower);
      if (!user) {
        if (!cfg.google.autoCreateUsers) {
          oauthRedirect(req, res, 'no_account'); return;
        }
        user = {
          username: emailLower,
          role: 'user',
          authProvider: 'google',
          googleName: name || '',
          createdAt: new Date().toISOString(),
        };
        users.push(user);
        saveUsers(users);
        console.log(`[manager] Auto-created Google user: ${emailLower}`);
      } else {
        if (!user.authProvider) user.authProvider = 'google';
        if (name && !user.googleName) user.googleName = name;
        saveUsers(users);
      }

      const { token: sessToken, csrf: sessCsrf } = createSession(user.username, user.role);
      const secureSuffix = isSecureRequest(req) ? '; Secure' : '';
      const prefix = getExternalPrefix(req);
      let redirectTarget = `${prefix}/`;
      if (oauthState?.returnTo) {
        try {
          const rt = new URL(oauthState.returnTo);
          const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
          if (rt.hostname === host && rt.protocol === 'https:') {
            redirectTarget = `${prefix}/?returnTo=${encodeURIComponent(oauthState.returnTo)}`;
          }
        } catch {}
      }
      res.writeHead(302, {
        Location: redirectTarget,
        'Set-Cookie': `manager_session=${sessToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureSuffix}`,
      });
      res.end(); return;
    } catch (e) {
      console.error('[manager] Google OAuth callback error:', e.message);
      oauthRedirect(req, res, 'oauth_error'); return;
    }
  }

  // ── All other API routes require auth ─────────────────────────────
  // Service key auth: container-to-container calls bypass session/CSRF
  const serviceKey = req.headers['x-service-key'];
  const isServiceAuth = MANAGER_SERVICE_KEY && serviceKey
    && serviceKey.length === MANAGER_SERVICE_KEY.length
    && crypto.timingSafeEqual(Buffer.from(serviceKey), Buffer.from(MANAGER_SERVICE_KEY));

  const session = isServiceAuth
    ? { token: 'service', csrf: 'service', username: 'service', role: 'super' }
    : validateSession(req);
  if (!session) {
    return json(res, { error: 'Unauthorized' }, 401);
  }

  // Mutating requests require CSRF (skipped for service key auth and auth endpoints)
  const csrfExempt = ['/api/auth/login', '/api/auth/logout'];
  if (!isServiceAuth && !csrfExempt.includes(pathname) && ['POST', 'PUT', 'DELETE'].includes(req.method) && !validateCSRF(req, session)) {
    return json(res, { error: 'Invalid CSRF token' }, 403);
  }

  // ── Auth config management (super only) ─────────────────────────────
  if (pathname === '/api/auth/config' || pathname.startsWith('/api/auth/allowed-emails')) {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);

    if (pathname === '/api/auth/config' && req.method === 'GET') {
      const cfg = loadAuthConfig();
      const masked = { ...cfg.google, clientSecret: cfg.google.clientSecret ? '••••••••' : '' };
      return json(res, { google: masked, redirectUri: getRedirectUri(req) });
    }

    if (pathname === '/api/auth/config' && req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const cfg = loadAuthConfig();
        if (body.google) {
          if (typeof body.google.enabled === 'boolean') cfg.google.enabled = body.google.enabled;
          if (typeof body.google.clientId === 'string') cfg.google.clientId = body.google.clientId.trim();
          if (typeof body.google.clientSecret === 'string' && body.google.clientSecret !== '••••••••') {
            cfg.google.clientSecret = body.google.clientSecret.trim();
          }
          if (typeof body.google.allowedDomain === 'string') cfg.google.allowedDomain = body.google.allowedDomain.trim().toLowerCase();
          if (typeof body.google.autoCreateUsers === 'boolean') cfg.google.autoCreateUsers = body.google.autoCreateUsers;
        }
        saveAuthConfig(cfg);
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }

    if (pathname === '/api/auth/allowed-emails' && req.method === 'GET') {
      const cfg = loadAuthConfig();
      return json(res, { emails: cfg.google.allowedEmails || [] });
    }

    if (pathname === '/api/auth/allowed-emails' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const email = (body.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) return json(res, { error: 'Invalid email' }, 400);
        const cfg = loadAuthConfig();
        if (!cfg.google.allowedEmails) cfg.google.allowedEmails = [];
        if (cfg.google.allowedEmails.includes(email)) return json(res, { error: 'Email already in list' }, 409);
        cfg.google.allowedEmails.push(email);
        saveAuthConfig(cfg);
        return json(res, { ok: true, emails: cfg.google.allowedEmails });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }

    const emailDeleteMatch = pathname.match(/^\/api\/auth\/allowed-emails\/(.+)$/);
    if (emailDeleteMatch && req.method === 'DELETE') {
      const emailToRemove = decodeURIComponent(emailDeleteMatch[1]).toLowerCase();
      const cfg = loadAuthConfig();
      cfg.google.allowedEmails = (cfg.google.allowedEmails || []).filter(e => e !== emailToRemove);
      saveAuthConfig(cfg);
      return json(res, { ok: true, emails: cfg.google.allowedEmails });
    }
  }

  // ── Ollama management ─────────────────────────────────────────────
  // Reads status from a file written by the host-side watcher (no direct
  // container-to-host network access needed). Only `pull` is allowed as
  // a write operation — install/start must be done on the host directly.

  if ((pathname === '/api/ollama/status' || pathname === '/api/ollama/pull') && session.role !== 'super') {
    return json(res, { error: 'Forbidden' }, 403);
  }

  if (pathname === '/api/ollama/status' && req.method === 'GET') {
    const statusPath = path.join(ANIMAS_DIR, '.ollama-status.json');
    try {
      if (fs.existsSync(statusPath)) {
        const data = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        return json(res, data);
      }
    } catch {}
    return json(res, { running: false, models: [] });
  }

  if (pathname === '/api/ollama/pull' && req.method === 'POST') {
    const body = await readBody(req);
    const model = body?.model;
    if (!model || typeof model !== 'string' || model.length > 200) {
      return json(res, { error: 'Invalid model name' }, 400);
    }
    const sanitized = model.replace(/[^a-zA-Z0-9._:/-]/g, '');
    if (!sanitized) return json(res, { error: 'Invalid model name' }, 400);
    fs.writeFileSync(path.join(ANIMAS_DIR, '.ollama-cmd'), JSON.stringify({ action: 'pull', model: sanitized, ts: Date.now() }));
    return json(res, { ok: true, message: `Pulling ${sanitized}... check status in a moment.` });
  }

  if (pathname === '/api/ollama/result' && req.method === 'GET') {
    const resultPath = path.join(ANIMAS_DIR, '.ollama-result');
    try {
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        return json(res, result);
      }
    } catch {}
    return json(res, { status: 'no_result' });
  }

  // ── Default API keys (shared across all animas) ──────────────────
  if (pathname === '/api/defaults' && req.method === 'GET') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    const defaults = parseEnvFile(DEFAULTS_FILE);
    return json(res, { defaults: maskSensitive(defaults) });
  }

  if (pathname === '/api/defaults' && req.method === 'PUT') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    const updates = await readBody(req);
    if (!updates || typeof updates !== 'object') return json(res, { error: 'Invalid payload' }, 400);
    const current = parseEnvFile(DEFAULTS_FILE);
    const currentMasked = maskSensitive(current);
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_DEFAULT_KEYS.has(key)) continue;
      if (value === '' || value === null || value === undefined) {
        delete current[key];
      } else {
        const strVal = String(value);
        if (SENSITIVE_KEYS.has(key) && strVal === currentMasked[key]) continue;
        if (validateEnvValue(strVal)) {
          current[key] = strVal;
        }
      }
    }
    // Write only allowed default keys
    const lines = [];
    for (const [key, value] of Object.entries(current)) {
      if (!ALLOWED_DEFAULT_KEYS.has(key)) continue;
      if (!validateEnvValue(value)) continue;
      lines.push(`${key}=${value}`);
    }
    fs.writeFileSync(DEFAULTS_FILE, lines.join('\n') + '\n');
    return json(res, { ok: true, defaults: maskSensitive(current) });
  }

  // ── Ingress config (domain, HTTPS, reconfigure) ──────────────────
  if (pathname === '/api/ingress' && req.method === 'GET') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    const ingress = readIngress();
    let traefikRunning = false;
    if (!BARE_MODE) {
      try {
        const out = require('child_process').execSync('docker ps --format "{{.Names}}" 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
        traefikRunning = out.split('\n').some(n => n.trim() === 'traefik');
      } catch {}
    }
    let tailscale = null;
    try {
      const tsOut = require('child_process').execSync('tailscale status --json 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const tsData = JSON.parse(tsOut);
      const dnsName = (tsData.Self && tsData.Self.DNSName) ? tsData.Self.DNSName.replace(/\.$/, '') : null;
      const tsIPs = (tsData.Self && tsData.Self.TailscaleIPs) || [];
      if (dnsName) tailscale = { hostname: dnsName, ips: tsIPs };
    } catch {}
    return json(res, { ...ingress, traefikRunning, tailscale });
  }

  if (pathname === '/api/ingress' && req.method === 'PUT') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    if (BARE_MODE) return json(res, { error: 'Ingress config requires Docker mode' }, 400);
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, { error: 'Invalid payload' }, 400);

    const newDomain = (body.domain || '').trim();
    const newHttps = body.https === true && !!newDomain;
    const newEmail = (body.email || '').trim();
    const externalAccess = body.externalAccess === true;
    const currentIngress = readIngress();
    const httpPort = newDomain ? 80 : (currentIngress.httpPort || 18000);
    const bindAddr = (newDomain || externalAccess) ? '0.0.0.0' : '127.0.0.1';

    writeIngress({ domain: newDomain, https: newHttps, email: newEmail, httpPort, traefikDir: path.join(ANIMAS_DIR, '..', 'traefik'), external: false, externalAccess });

    const { execSync } = require('child_process');
    const traefikDir = path.resolve(ANIMAS_DIR, '..', 'traefik');
    const steps = [];

    try {
      // 1. Regenerate traefik.yml
      let entrypoints, certResolver = '';
      if (newHttps) {
        entrypoints = `entryPoints:\n  web:\n    address: \":${httpPort}\"\n    http:\n      redirections:\n        entryPoint:\n          to: websecure\n          scheme: https\n          permanent: true\n  websecure:\n    address: \":443\"`;
        certResolver = `certificatesResolvers:\n  letsencrypt:\n    acme:\n      email: ${newEmail}\n      storage: /acme.json\n      httpChallenge:\n        entryPoint: web`;
      } else {
        entrypoints = `entryPoints:\n  web:\n    address: \":${httpPort}\"`;
      }
      const traefikYml = `global:\n  checkNewVersion: false\n  sendAnonymousUsage: false\n\nlog:\n  level: INFO\n\napi:\n  dashboard: true\n  insecure: false\n\n${entrypoints}\n\n${certResolver}\n\nproviders:\n  docker:\n    endpoint: "tcp://docker-proxy:2375"\n    exposedByDefault: false\n    network: anima-web\n`;
      fs.writeFileSync(path.join(traefikDir, 'traefik.yml'), traefikYml);

      // Write traefik .env
      fs.writeFileSync(path.join(traefikDir, '.env'), `TRAEFIK_DOMAIN=${newDomain}\nTRAEFIK_HTTPS=${newHttps}\nTRAEFIK_ACME_EMAIL=${newEmail}\nTRAEFIK_NETWORK=anima-web\nTRAEFIK_HTTP_PORT=${httpPort}\n`);

      if (newHttps) {
        const acmePath = path.join(traefikDir, 'acme.json');
        if (!fs.existsSync(acmePath)) { fs.writeFileSync(acmePath, ''); fs.chmodSync(acmePath, 0o600); }
      }
      steps.push('traefik config updated');

      // 2. Update Traefik compose port and restart
      const traefikCompose = path.join(traefikDir, 'docker-compose.yml');
      if (fs.existsSync(traefikCompose)) {
        let tc = fs.readFileSync(traefikCompose, 'utf8');
        tc = tc.replace(/"(?:[\d.]+:)?(\d+):(\d+)"(\s*#\s*http)?/m, `"${bindAddr}:${httpPort}:${httpPort}"`);
        fs.writeFileSync(traefikCompose, tc);
      }
      try { execSync(`cd "${traefikDir}" && docker compose up -d`, { timeout: 30000, encoding: 'utf8' }); steps.push('traefik restarted'); } catch (e) { steps.push('traefik restart failed: ' + e.message); }

      // 3. Regenerate manager labels + restart
      const managerDir = path.resolve(ANIMAS_DIR, '..', 'manager');
      const managerComposeFile = path.join(managerDir, 'docker-compose.yml');
      if (fs.existsSync(managerComposeFile)) {
        let mc = fs.readFileSync(managerComposeFile, 'utf8');
        const entrypoint = newHttps ? 'websecure' : 'web';
        const routerRule = newDomain ? `Host(\`${newDomain}\`) && PathPrefix(\`/manager\`)` : `PathPrefix(\`/manager\`)`;
        const tlsLabel = newHttps ? `\n      - "traefik.http.routers.anima-manager.tls.certresolver=letsencrypt"` : '';
        const newLabels = `    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=anima-web"
      - "traefik.http.routers.anima-manager.rule=${routerRule}"
      - "traefik.http.routers.anima-manager.entrypoints=${entrypoint}"${tlsLabel}
      - "traefik.http.services.anima-manager.loadbalancer.server.port=\${MANAGER_PORT:-18900}"
      - "traefik.http.middlewares.manager-strip.stripprefix.prefixes=/manager"
      - "traefik.http.routers.anima-manager.middlewares=manager-strip"`;
        mc = mc.replace(/    labels:\n(?:      - "[^\n]*"\n?)*/m, newLabels + '\n');
        fs.writeFileSync(managerComposeFile, mc);
        try { execSync(`cd "${managerDir}" && docker compose up -d --build`, { timeout: 120000, encoding: 'utf8' }); steps.push('manager restarted'); } catch (e) { steps.push('manager restart failed: ' + e.message); }
      }

      // 4. Reconfigure each agent's Traefik labels
      const agentDirs = fs.readdirSync(ANIMAS_DIR).filter(d => !d.startsWith('.') && d !== '.template');
      for (const dir of agentDirs) {
        const agentCompose = path.join(ANIMAS_DIR, dir, 'docker-compose.yml');
        if (!fs.existsSync(agentCompose)) continue;
        let ac = fs.readFileSync(agentCompose, 'utf8');
        const agentEnvFile = path.join(ANIMAS_DIR, dir, '.env');
        let agentWebPort = '18800';
        if (fs.existsSync(agentEnvFile)) {
          const agentEnv = parseEnvFile(agentEnvFile);
          agentWebPort = agentEnv.ANIMA_WEB_PORT || '18800';
          // Update ANIMA_PUBLIC_URL to reflect new ingress
          const agentBasePath = `/animas/${dir}`;
          let newPublicUrl;
          if (newDomain) {
            const proto = newHttps ? 'https' : 'http';
            newPublicUrl = `${proto}://${newDomain}${agentBasePath}`;
          } else {
            const portSuffix = httpPort == 80 ? '' : `:${httpPort}`;
            newPublicUrl = `http://localhost${portSuffix}${agentBasePath}`;
          }
          const envContent = fs.readFileSync(agentEnvFile, 'utf8');
          const updatedEnv = envContent.includes('ANIMA_PUBLIC_URL=')
            ? envContent.replace(/ANIMA_PUBLIC_URL=.*/, `ANIMA_PUBLIC_URL=${newPublicUrl}`)
            : envContent.trimEnd() + `\nANIMA_PUBLIC_URL=${newPublicUrl}\n`;
          fs.writeFileSync(agentEnvFile, updatedEnv);
        }
        const agentPath = `/animas/${dir}`;
        const agentEntrypoint = newHttps ? 'websecure' : 'web';
        const agentRule = newDomain
          ? `Host(\`${newDomain}\`) && (PathPrefix(\`${agentPath}/\`) || Path(\`${agentPath}\`))`
          : `PathPrefix(\`${agentPath}/\`) || Path(\`${agentPath}\`)`;
        const agentTls = newHttps ? `\n      - "traefik.http.routers.${dir}.tls.certresolver=letsencrypt"` : '';
        const agentLabels = `    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=anima-web"
      - "traefik.http.routers.${dir}.rule=${agentRule}"
      - "traefik.http.routers.${dir}.priority=${200 + agentPath.length}"
      - "traefik.http.routers.${dir}.entrypoints=${agentEntrypoint}"${agentTls}
      - "traefik.http.services.${dir}.loadbalancer.server.port=${agentWebPort}"
      - "traefik.http.middlewares.${dir}-strip.stripprefix.prefixes=${agentPath}"
      - "traefik.http.routers.${dir}.middlewares=${dir}-strip"`;
        if (ac.includes('labels:')) {
          ac = ac.replace(/    labels:\n(?:      - "[^\n]*"\n?)*/m, agentLabels + '\n');
        } else {
          ac = ac.replace(/(    networks:\n)/m, agentLabels + '\n$1');
        }
        fs.writeFileSync(agentCompose, ac);
        try { execSync(`cd "${path.join(ANIMAS_DIR, dir)}" && docker compose up -d`, { timeout: 30000, encoding: 'utf8' }); steps.push(`${dir} restarted`); } catch (e) { steps.push(`${dir} restart failed: ${e.message}`); }
      }
    } catch (e) {
      return json(res, { error: e.message, steps }, 500);
    }

    return json(res, { ok: true, steps, domain: newDomain, https: newHttps });
  }

  // ── Cloudflare Quick Tunnel ────────────────────────────────────────

  if (pathname === '/api/tunnel/status' && req.method === 'GET') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    const running = tunnelProcess !== null && tunnelProcess.exitCode === null;
    let cloudflaredAvailable = false;
    try {
      if (BARE_MODE) {
        require('child_process').execSync('which cloudflared 2>/dev/null || command -v cloudflared 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        cloudflaredAvailable = true;
      } else {
        require('child_process').execSync('docker image inspect cloudflare/cloudflared >/dev/null 2>&1 || docker pull --quiet cloudflare/cloudflared 2>/dev/null', { encoding: 'utf8', timeout: 30000 });
        cloudflaredAvailable = true;
      }
    } catch { cloudflaredAvailable = BARE_MODE ? false : true; }
    return json(res, { running, url: tunnelUrl, error: tunnelError, cloudflaredAvailable });
  }

  if (pathname === '/api/tunnel/start' && req.method === 'POST') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    if (tunnelProcess && tunnelProcess.exitCode === null) {
      return json(res, { error: 'Tunnel already running', url: tunnelUrl });
    }

    const ingress = readIngress();
    const httpPort = ingress.httpPort || 18000;
    const { spawn, execSync } = require('child_process');
    tunnelUrl = null;
    tunnelError = null;

    try {
      if (BARE_MODE) {
        tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${httpPort}`, '--no-autoupdate'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false
        });
      } else {
        tunnelProcess = spawn('docker', [
          'run', '--rm', '--name', 'anima-cloudflared',
          '--network', 'anima-web',
          'cloudflare/cloudflared',
          'tunnel', '--url', `http://traefik:${httpPort}`, '--no-autoupdate'
        ], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
      }
    } catch (e) {
      tunnelError = e.message;
      return json(res, { error: 'Failed to start cloudflared: ' + e.message }, 500);
    }

    let urlResolved = false;
    const urlRegex = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

    const handleOutput = (data) => {
      const line = data.toString();
      if (!urlResolved) {
        const match = line.match(urlRegex);
        if (match) {
          tunnelUrl = match[0];
          urlResolved = true;
        }
      }
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('error', (err) => {
      tunnelError = err.message;
      tunnelProcess = null;
    });

    tunnelProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) tunnelError = `cloudflared exited with code ${code}`;
      tunnelProcess = null;
    });

    // Wait up to 15s for the URL to appear
    const start = Date.now();
    while (!urlResolved && (Date.now() - start) < 15000) {
      await new Promise(r => setTimeout(r, 500));
      if (tunnelProcess === null) break;
    }

    if (tunnelUrl) {
      return json(res, { ok: true, url: tunnelUrl });
    } else {
      return json(res, { ok: true, url: null, message: 'Tunnel started but URL not yet available. Check status in a moment.' });
    }
  }

  if (pathname === '/api/tunnel/stop' && req.method === 'POST') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    if (tunnelProcess && tunnelProcess.exitCode === null) {
      try { tunnelProcess.kill('SIGTERM'); } catch {}
    }
    if (!BARE_MODE) {
      try { require('child_process').execSync('docker rm -f anima-cloudflared 2>/dev/null', { encoding: 'utf8', timeout: 10000 }); } catch {}
    }
    tunnelProcess = null;
    tunnelUrl = null;
    tunnelError = null;
    return json(res, { ok: true });
  }

  // ── List animas ────────────────────────────────────────────────────
  if (pathname === '/api/animas' && req.method === 'GET') {
    const animas = listAnimas(session);
    return json(res, { animas });
  }

  // ── Create anima ───────────────────────────────────────────────────
  if (pathname === '/api/animas' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let {
        displayName, discordToken, anthropicKey, telegramToken,
        slackBotToken, slackAppToken,
        nicknames, vibe, commStyle, quirks, interests,
        dmPolicy,
        webEnabled, webAuthUser, webAuthPass,
        ingressMode, ingressDomain, ingressPath, ingressHttps,
        personalityEditable, srcEditable,
        voiceEnabled, ttsProvider, ttsVoice, ttsEdgeVoice,
        cloneFrom, copyGraph,
        learnerModel, learningMode,
      } = body;

      if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 2) {
        return json(res, { error: 'Display name is required (min 2 characters)' }, 400);
      }
      displayName = displayName.trim();
      if (!/[a-z]/i.test(displayName)) {
        return json(res, { error: 'Display name must contain at least one letter' }, 400);
      }

      const agentId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!agentId || agentId.length < 2) {
        return json(res, { error: 'Display name must produce a valid agent ID (at least 2 alphanumeric characters)' }, 400);
      }

      const RESERVED = ['manager', 'api', 'static', 'admin', 'root', 'anima', 'traefik', 'proxy', 'docker'];
      if (RESERVED.includes(agentId)) {
        return json(res, { error: `'${agentId}' is a reserved name` }, 400);
      }

      // Check for name collisions (directory exists OR display name already in use)
      const newDir = path.join(ANIMAS_DIR, agentId);
      if (fs.existsSync(newDir)) {
        return json(res, { error: `${brand.Agent} '${agentId}' already exists` }, 409);
      }
      const lowerName = displayName.toLowerCase();
      try {
        for (const n of fs.readdirSync(ANIMAS_DIR)) {
          if (n.startsWith('.')) continue;
          const cfgPath = path.join(ANIMAS_DIR, n, 'anima.json');
          try {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (cfg.displayName && cfg.displayName.toLowerCase() === lowerName) {
              return json(res, { error: `Display name '${displayName}' is already taken by ${brand.agent} '${n}'` }, 409);
            }
          } catch {}
        }
      } catch {}

      // Find available ports from all sources (.env, docker-compose.yml defaults)
      const usedPorts = new Set();
      try {
        for (const n of fs.readdirSync(ANIMAS_DIR)) {
          if (n.startsWith('.')) continue;
          const dir = path.join(ANIMAS_DIR, n);
          try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
          // Source 1: .env files
          const env = parseEnvFile(path.join(dir, '.env'));
          if (env.ANIMA_HEALTH_PORT) usedPorts.add(parseInt(env.ANIMA_HEALTH_PORT, 10));
          if (env.ANIMA_WEB_PORT) usedPorts.add(parseInt(env.ANIMA_WEB_PORT, 10));
          if (!BARE_MODE) {
            try {
              const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
              for (const m of compose.matchAll(/:-(\d{4,5})\}/g)) {
                usedPorts.add(parseInt(m[1], 10));
              }
              for (const m of compose.matchAll(/127\.0\.0\.1:(\d{4,5})/g)) {
                usedPorts.add(parseInt(m[1], 10));
              }
            } catch {}
          }
        }
      } catch {}

      let healthPort = 18790;
      while (usedPorts.has(healthPort)) healthPort++;
      usedPorts.add(healthPort);

      let webPort = 18800;
      if (webEnabled === true) {
        while (usedPorts.has(webPort)) webPort++;
        usedPorts.add(webPort);
      }

      // Copy source — from clone or base
      const baseSrc = '/anima-base-src';
      const baseSrcAlt = path.resolve(ANIMAS_DIR, '..', 'src');
      const templateSrc = path.join(ANIMAS_DIR, '.template', 'src');
      let srcToCopy = fs.existsSync(baseSrc) ? baseSrc : (fs.existsSync(baseSrcAlt) ? baseSrcAlt : templateSrc);

      if (cloneFrom && validateAnimaId(cloneFrom)) {
        const cloneSrc = path.join(ANIMAS_DIR, cloneFrom, 'src');
        if (fs.existsSync(cloneSrc)) srcToCopy = cloneSrc;
      }

      fs.mkdirSync(newDir, { recursive: true });
      fs.mkdirSync(path.join(newDir, 'data'), { recursive: true });
      fs.mkdirSync(path.join(newDir, 'workspace', 'web'), { recursive: true });
      fs.mkdirSync(path.join(newDir, 'workspace', 'plugins'), { recursive: true });
      fs.mkdirSync(path.join(newDir, 'static'), { recursive: true });
      if (!BARE_MODE) {
        copyDirSync(srcToCopy, path.join(newDir, 'src'));
      }

      if (!BARE_MODE) {
        const templateDockerfile = path.join(ANIMAS_DIR, '.template', 'src', 'Dockerfile');
        if (fs.existsSync(templateDockerfile)) {
          fs.copyFileSync(templateDockerfile, path.join(newDir, 'src', 'Dockerfile'));
        }
      }

      // Ensure shared directories exist (non-fatal if permissions prevent it)
      const sharedSkillsDir = path.join(ANIMAS_DIR, '..', 'shared', 'skills');
      try { fs.mkdirSync(sharedSkillsDir, { recursive: true }); } catch {}
      try { fs.mkdirSync(SHARED_GRAPHS_DIR, { recursive: true }); } catch {}

      // Copy brand.json so the container can serve branded UI
      if (fs.existsSync(brandPath)) {
        fs.copyFileSync(brandPath, path.join(newDir, 'brand.json'));
      }

      // Copy graph-viewer.html and brand.js into per-agent static/ so the
      // ./static:/app/static bind mount doesn't shadow the source copies
      const baseSrcStatic = fs.existsSync(baseSrc) ? path.join(baseSrc, 'static') : path.join(baseSrcAlt, 'static');
      for (const f of ['graph-viewer.html', 'brand.js']) {
        const src = path.join(baseSrcStatic, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(newDir, 'static', f));
      }

      // Copy graph if cloning with graph
      if (copyGraph && cloneFrom && validateAnimaId(cloneFrom)) {
        const cloneGraphPath = path.join(ANIMAS_DIR, cloneFrom, 'data', 'graph.db');
        if (fs.existsSync(cloneGraphPath)) {
          fs.copyFileSync(cloneGraphPath, path.join(newDir, 'data', 'graph.db'));
          const walPath = cloneGraphPath + '-wal';
          const shmPath = cloneGraphPath + '-shm';
          if (fs.existsSync(walPath)) fs.copyFileSync(walPath, path.join(newDir, 'data', 'graph.db-wal'));
          if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, path.join(newDir, 'data', 'graph.db-shm'));
          // Remap agent IDs in the copied graph
          try {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(path.join(newDir, 'data', 'graph.db'));
            db.prepare(`UPDATE nodes SET id=?, label=?, updated=datetime('now') WHERE id=?`).run(agentId, displayName, cloneFrom);
            db.prepare(`UPDATE aspects SET node_id=? WHERE node_id=?`).run(agentId, cloneFrom);
            db.prepare(`UPDATE edges SET source=? WHERE source=?`).run(agentId, cloneFrom);
            db.prepare(`UPDATE edges SET target=? WHERE target=?`).run(agentId, cloneFrom);
            db.prepare(`UPDATE aliases SET node_id=? WHERE node_id=?`).run(agentId, cloneFrom);
            db.close();
          } catch {}
        }
      }

      // Parse nicknames
      const nicknamesList = nicknames
        ? nicknames.split(',').map(n => n.trim().toLowerCase()).filter(Boolean)
        : [displayName.split(/\s+/)[0].toLowerCase()];

      // Write anima.json
      const animaConfig = {
        agentId,
        displayName,
        nicknames: nicknamesList,
        guilds: {},
        privacy: { default: { private: false, learn: true, shareToFeed: true, respond: true } },
        channels: {
          telegram: {
            enabled: !!telegramToken,
            dmPolicy: dmPolicy || 'pairing',
            groupPolicy: 'open',
            requireMention: true,
          },
          slack: {
            enabled: !!(slackBotToken && slackAppToken),
            requireMention: true,
            textChunkLimit: 3000,
            dmPolicy: 'open',
          },
        },
      };
      if (body.superAgent) animaConfig.superAgent = true;
      fs.writeFileSync(path.join(newDir, 'anima.json'), JSON.stringify(animaConfig, null, 2) + '\n');

      // Seed personality into graph SQL
      if (vibe || commStyle || quirks || interests) {
        const seedPath = path.join(newDir, 'src', 'seed-graph.sql');
        const esc = s => (s || '').replace(/'/g, "''");
        let sql = '\n\n-- PERSONALITY SEED (generated by manager wizard)\n';
        sql += `UPDATE nodes SET label = '${esc(displayName)}', description = '${esc(displayName)} — ${esc(vibe)}' WHERE id = 'AGENT_ID';\n`;
        sql += `INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('AGENT_ID', 'display', 9, 'seed');\n`;
        sql += `INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES\n`;
        sql += `  ((SELECT MAX(id) FROM aspects), 'Display name: ${esc(displayName)}', 10, 'seed', 'seed'),\n`;
        sql += `  ((SELECT MAX(id) FROM aspects), 'Goes by: ${esc(nicknames || nicknamesList.join(', '))}', 9, 'seed', 'seed');\n`;
        if (vibe) {
          sql += `INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('AGENT_ID', 'personality', 9, 'seed');\n`;
          sql += `INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES\n`;
          sql += `  ((SELECT MAX(id) FROM aspects), 'Core vibe: ${esc(vibe)}', 9, 'seed', 'seed');\n`;
        }
        if (commStyle) {
          sql += `INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('AGENT_ID', 'communication', 9, 'seed');\n`;
          sql += `INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES\n`;
          sql += `  ((SELECT MAX(id) FROM aspects), '${esc(commStyle)}', 9, 'seed', 'seed');\n`;
        }
        if (quirks) {
          sql += `INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)\n`;
          sql += `SELECT MAX(id), '${esc(quirks)}', 8, 'seed', 'seed' FROM aspects WHERE node_id = 'AGENT_ID' AND name = 'communication';\n`;
        }
        if (interests) {
          sql += `INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('AGENT_ID', 'interests', 7, 'seed');\n`;
          sql += `INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES\n`;
          sql += `  ((SELECT MAX(id) FROM aspects), 'Interests and expertise: ${esc(interests)}', 7, 'seed', 'seed');\n`;
        }
        if (fs.existsSync(seedPath)) {
          fs.appendFileSync(seedPath, sql);
        }
      }

      // Merge shared defaults
      const sharedDefaults = parseEnvFile(DEFAULTS_FILE);
      const resolve = (val, key) => (val && String(val).trim()) ? val : (sharedDefaults[key] || '');

      // Resolve the base model — use whatever the user configured, no hardcoded fallback
      const baseModel = sharedDefaults.ANIMA_MODEL || '';
      if (!baseModel) {
        return json(res, { error: 'No model configured. Set up a provider in Settings before creating an agent.' }, 400);
      }

      // Write .env — API keys come from the vault at startup, not .env
      const envLines = [
        `DISCORD_TOKEN=${discordToken || ''}`,
        `AGENT_ID=${agentId}`,
        `ANIMA_DISPLAY_NAME=${displayName}`,
        `ANIMA_NICKNAMES=${nicknamesList.join(', ')}`,
        `ANIMA_MODEL=${baseModel}`,
        `ANIMA_CASUAL_MODEL=${sharedDefaults.ANIMA_CASUAL_MODEL || baseModel}`,
        `ANIMA_NORMAL_MODEL=${sharedDefaults.ANIMA_NORMAL_MODEL || baseModel}`,
        `ANIMA_PLANNER_MODEL=${sharedDefaults.ANIMA_PLANNER_MODEL || baseModel}`,
        `ANIMA_SUBAGENT_MODEL=${sharedDefaults.ANIMA_SUBAGENT_MODEL || baseModel}`,
        `ANIMA_HEALTH_PORT=${healthPort}`,
        `ANIMA_LOG_LEVEL=info`,
        `GRAPH_DB_PATH=${BARE_MODE ? path.join(newDir, 'data', 'graph.db') : '/data/graph.db'}`,
        `SESSION_DB_PATH=${BARE_MODE ? path.join(newDir, 'data', 'sessions.db') : '/data/sessions.db'}`,
        `TELEGRAM_BOT_TOKEN=${telegramToken || ''}`,
        `SLACK_BOT_TOKEN=${slackBotToken || ''}`,
        `SLACK_APP_TOKEN=${slackAppToken || ''}`,
      ];
      // Only write explicit per-anima API keys if the user provided them in the form;
      // otherwise they'll be loaded from the vault at boot
      if (anthropicKey) envLines.push(`ANTHROPIC_API_KEY=${anthropicKey}`);

      // Voice
      envLines.push(`ANIMA_VOICE_ENABLED=${voiceEnabled === true ? 'true' : 'false'}`);
      if (ttsProvider) envLines.push(`ANIMA_TTS_PROVIDER=${ttsProvider}`);
      if (ttsVoice) envLines.push(`ANIMA_TTS_VOICE=${ttsVoice}`);
      if (ttsEdgeVoice) envLines.push(`ANIMA_TTS_EDGE_VOICE=${ttsEdgeVoice}`);

      // Web config (ingress is handled via Traefik labels, not env vars)
      if (webEnabled === true) {
        envLines.push(`ANIMA_WEB_PORT=${webPort}`);
        if (webAuthUser) envLines.push(`ANIMA_WEB_AUTH_USER=${webAuthUser}`);
        if (webAuthPass) envLines.push(`ANIMA_WEB_AUTH_PASS=${webAuthPass}`);
      }

      // Permissions
      envLines.push(`ANIMA_PERSONALITY_EDITABLE=${personalityEditable ? 'true' : 'false'}`);
      envLines.push(`ANIMA_SRC_EDITABLE=${srcEditable ? 'true' : 'false'}`);

      // Context & Learning
      envLines.push(`ANIMA_LEARNER_MODEL=${resolve(learnerModel || '', 'ANIMA_LEARNER_MODEL')}`);
      envLines.push(`ANIMA_LEARNING_MODE=${learningMode || resolve('', 'ANIMA_LEARNING_MODE') || 'always'}`);
      envLines.push(`ANIMA_CONTEXT_WINDOW=${resolve('', 'ANIMA_CONTEXT_WINDOW') || '200000'}`);
      envLines.push(`ANIMA_COMPACT_THRESHOLD=${resolve('', 'ANIMA_COMPACT_THRESHOLD') || '80000'}`);
      envLines.push(`ANIMA_COMPACT_KEEP_TAIL=${resolve('', 'ANIMA_COMPACT_KEEP_TAIL') || '20'}`);
      envLines.push(`ANIMA_MAINTAINER_IDLE_ONLY=${resolve('', 'ANIMA_MAINTAINER_IDLE_ONLY') || 'true'}`);

      if (BARE_MODE) {
        envLines.push(`ANIMA_WORKSPACE_PATH=${path.join(newDir, 'workspace')}`);
        envLines.push(`SHARED_SKILLS_DIR=${path.join(SHARED_DIR, 'skills')}`);
        envLines.push(`SHARED_GRAPHS_DIR=${SHARED_GRAPHS_DIR}`);
      }

      // Manager connection (SSO for graph viewer auth)
      envLines.push(`MANAGER_URL=http://${BARE_MODE ? '127.0.0.1' : 'anima-manager'}:${PORT}`);
      envLines.push(`MANAGER_SERVICE_KEY=${MANAGER_SERVICE_KEY || crypto.randomBytes(24).toString('hex')}`);

      // Public URL so the agent knows how to link to itself
      const ingress = readIngress();
      const agentBasePath = `/animas/${agentId}`;
      if (ingress.domain) {
        const proto = ingress.https ? 'https' : 'http';
        envLines.push(`ANIMA_PUBLIC_URL=${proto}://${ingress.domain}${agentBasePath}`);
      } else {
        const httpPort = ingress.httpPort || 18000;
        const portSuffix = httpPort == 80 ? '' : `:${httpPort}`;
        envLines.push(`ANIMA_PUBLIC_URL=http://localhost${portSuffix}${agentBasePath}`);
      }

      // Agent ownership (set to the session user)
      envLines.push(`ANIMA_OWNER=${session.username}`);

      // Proactive outreach
      if (body.proactiveEnabled) {
        envLines.push('ANIMA_PROACTIVE_ENABLED=true');
      }

      fs.writeFileSync(path.join(newDir, '.env'), envLines.join('\n') + '\n');

      if (BARE_MODE) {
        // Bare mode: generate run.sh instead of docker-compose.yml
        const nodeBin = process.execPath;
        const runSh = `#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/.env" 2>/dev/null; set +a
cd "${SRC_DIR}"
exec "${nodeBin}" index.js
`;
        fs.writeFileSync(path.join(newDir, 'run.sh'), runSh, { mode: 0o755 });

        // Seed the knowledge graph
        if (!fs.existsSync(path.join(newDir, 'data', 'graph.db'))) {
          try {
            seedProjectGraph(path.join(newDir, 'data', 'graph.db'));
            const seedSql = path.join(SRC_DIR, 'seed-graph.sql');
            if (fs.existsSync(seedSql)) {
              const { DatabaseSync } = require('node:sqlite');
              const db = new DatabaseSync(path.join(newDir, 'data', 'graph.db'));
              const raw = fs.readFileSync(seedSql, 'utf8');
              const sql = raw.replace(/AGENT_ID/g, agentId)
                             .replace(/AGENT_NAME/g, displayName);
              try { db.exec(sql); } catch {}
              db.close();
            }
          } catch (e) {
            console.warn(`[manager] Could not seed graph for ${agentId}: ${e.message}`);
          }
        }

        // Trigger watcher (bare mode uses run.sh as ready marker)
        const buildStatusPath = path.join(newDir, '.build-status.json');
        fs.writeFileSync(buildStatusPath, JSON.stringify({ state: 'queued', ts: Date.now() }) + '\n');

        return json(res, { ok: true, id: agentId, message: `${brand.Agent} '${displayName}' ${brand.createdVerb}. Starting agent…` }, 201);
      }

      // Docker mode: build docker-compose.yml
      const resolvedIngressPath = '/animas/' + agentId;
      const ingressCfg = readIngress();
      const resolvedDomain = ingressCfg.domain || '';
      const resolvedHttps = ingressCfg.https === true;
      const entrypoint = resolvedHttps ? 'websecure' : 'web';

      let webPortEnv = '';
      let srcVolumes = '';
      let hostVolumes = '';

      if (webEnabled === true) {
        webPortEnv = `      - ANIMA_WEB_PORT=\${ANIMA_WEB_PORT:-${webPort}}`;
      }
      let buildSection, imageLine;
      if (srcEditable) {
        srcVolumes = '      - ./src:/app:rw\n      - /app/node_modules\n      - ./static:/app/static\n';
        buildSection = `    build:\n      context: ./src\n      dockerfile: Dockerfile`;
        imageLine = `    image: anima-${agentId}:latest`;
      } else {
        srcVolumes = [
          '      - ../../src/agent:/app/agent:ro',
          '      - ../../src/benchmark:/app/benchmark:ro',
          '      - ../../src/graph:/app/graph:ro',
          '      - ../../src/gateways:/app/gateways:ro',
          '      - ../../src/providers:/app/providers:ro',
          '      - ../../src/workers:/app/workers:ro',
          '      - ../../src/tools:/app/tools:ro',
          '      - ../../src/voice:/app/voice:ro',
          '      - ./static:/app/static',
          '      - ../../src/index.js:/app/index.js:ro',
          '      - ../../src/app.js:/app/app.js:ro',
          '      - ../../src/config.js:/app/config.js:ro',
          '      - ../../src/entrypoint.sh:/app/entrypoint.sh:ro',
          '      - ./src/plugins:/app/plugins',
          '      - ./src/seed-graph.sql:/app/seed-graph.sql:ro',
        ].join('\n') + '\n';
        buildSection = '';
        imageLine = '    image: anima:latest';
      }

      // Always emit Traefik labels — PathPrefix-only when no domain, Host+PathPrefix when domain set
      let traefikLabels = '';
      if (webEnabled === true) {
        const router = agentId;
        const stripMw = `${agentId}-strip`;
        const pathPriority = 200 + resolvedIngressPath.length;
        const bt = '`';
        const routerRule = resolvedDomain
          ? `Host(${bt}${resolvedDomain}${bt}) && (PathPrefix(${bt}${resolvedIngressPath}/${bt}) || Path(${bt}${resolvedIngressPath}${bt}))`
          : `PathPrefix(${bt}${resolvedIngressPath}/${bt}) || Path(${bt}${resolvedIngressPath}${bt})`;
        const tlsLine = resolvedHttps ? `\n      - "traefik.http.routers.${router}.tls.certresolver=letsencrypt"` : '';
        traefikLabels = `    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=anima-web"
      - "traefik.http.routers.${router}.rule=${routerRule}"
      - "traefik.http.routers.${router}.priority=${pathPriority}"
      - "traefik.http.routers.${router}.entrypoints=${entrypoint}"${tlsLine}
      - "traefik.http.services.${router}.loadbalancer.server.port=${webPort}"
      - "traefik.http.middlewares.${stripMw}.stripprefix.prefixes=${resolvedIngressPath}"
      - "traefik.http.routers.${router}.middlewares=${stripMw}"`;
      }

      const srcEditableEnv = srcEditable ? '      - ANIMA_SRC_EDITABLE=true\n' : '';

      const compose = `services:
  anima:
${buildSection}
${imageLine}
    container_name: ${agentId}
    restart: unless-stopped

    extra_hosts:
      - "host.docker.internal:host-gateway"

    env_file:
      - .env

    environment:
      - GRAPH_DB_PATH=/data/graph.db
      - SESSION_DB_PATH=/data/sessions.db
      - ANIMA_WORKSPACE_PATH=/workspace
      - ANIMA_LOG_LEVEL=\${ANIMA_LOG_LEVEL:-info}
      - ANIMA_HEALTH_PORT=\${ANIMA_HEALTH_PORT:-${healthPort}}
${webPortEnv ? webPortEnv + '\n' : ''}\
${srcEditableEnv}\
    volumes:
      - ./data:/data
      - ./.env:/data/.env
      - ./anima.json:/app/anima.json:ro
      - ./brand.json:/app/brand.json:ro
      - ./workspace:/workspace
      - ../../shared/skills:/shared/skills
      - ../../shared/graphs:/shared/graphs
${srcVolumes}${hostVolumes}
    ports:
      - "127.0.0.1:\${ANIMA_HEALTH_PORT:-${healthPort}}:\${ANIMA_HEALTH_PORT:-${healthPort}}"

    networks:
      - default
      - anima-web
${traefikLabels ? traefikLabels + '\n' : ''}\
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 256M
    memswap_limit: 8G

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

    stop_grace_period: 10s

networks:
  anima-web:
    external: true
`;
      fs.writeFileSync(path.join(newDir, 'docker-compose.yml'), compose);

      // Write default web page if web enabled
      if (webEnabled === true) {
        const webIndex = path.join(newDir, 'workspace', 'web', 'index.html');
        if (!fs.existsSync(webIndex)) {
          const safeDisplayName = displayName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          fs.writeFileSync(webIndex, `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${safeDisplayName}</title></head><body><h1>${safeDisplayName}</h1><p>Web hosting is active.</p></body></html>\n`);
        }
      }

      // Trigger immediate build via watcher
      const buildStatusPath = path.join(newDir, '.build-status.json');
      fs.writeFileSync(buildStatusPath, JSON.stringify({ state: 'queued', ts: Date.now() }) + '\n');

      return json(res, { ok: true, id: agentId, message: `${brand.Agent} '${displayName}' ${brand.createdVerb}. Building container…` }, 201);
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── User preferences ──────────────────────────────────────────────
  if (pathname === '/api/preferences') {
    const VALID_THEMES = ['midnight','dark','paper','terminal','ember','arctic','neon','forest'];
    if (req.method === 'GET') {
      const users = loadUsers();
      const u = users.find(u => u.username === session.username);
      return json(res, { theme: u?.theme || 'midnight' });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const theme = VALID_THEMES.includes(body.theme) ? body.theme : 'midnight';
      const users = loadUsers();
      const u = users.find(u => u.username === session.username);
      if (u) { u.theme = theme; saveUsers(users); }
      return json(res, { ok: true, theme });
    }
  }

  // ── Vault: Admin CRUD (super only) ─────────────────────────────────
  if (pathname === '/api/vault/keys' || pathname.startsWith('/api/vault/keys/')) {
    if (session.role !== 'super') return json(res, { error: 'Forbidden — super role required' }, 403);
    const keyName = pathname.replace('/api/vault/keys/', '').replace('/api/vault/keys', '') || null;

    if (req.method === 'GET' && !keyName) {
      const keys = vaultList().map(k => ({
        name: k.name, scope: k.scope, description: k.description,
        createdAt: k.created_at, updatedAt: k.updated_at,
      }));
      return json(res, { keys });
    }

    if (req.method === 'GET' && keyName) {
      const entry = vaultGet(decodeURIComponent(keyName));
      if (!entry) return json(res, { error: 'Key not found' }, 404);
      vaultLog('read', entry.name, session.username);
      const masked = entry.value.length > 8
        ? entry.value.slice(0, 4) + '***' + entry.value.slice(-3)
        : '***';
      return json(res, { name: entry.name, maskedValue: masked, scope: entry.scope, description: entry.description });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const body = await readBody(req);
        if (!body.name || !body.value) return json(res, { error: 'name and value are required' }, 400);
        if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.name)) return json(res, { error: 'Invalid key name — use UPPER_SNAKE_CASE' }, 400);
        vaultSet(body.name, body.value, body.scope || 'global', body.description || '');
        vaultLog('set', body.name, session.username);
        return json(res, { ok: true, name: body.name });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }

    if (req.method === 'DELETE' && keyName) {
      const deleted = vaultDelete(decodeURIComponent(keyName));
      if (!deleted) return json(res, { error: 'Key not found' }, 404);
      vaultLog('delete', decodeURIComponent(keyName), session.username);
      return json(res, { ok: true });
    }
  }

  if (pathname === '/api/vault/log' && req.method === 'GET') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    const db = getVaultDb();
    const rows = db.prepare('SELECT * FROM vault_log ORDER BY id DESC LIMIT 200').all();
    return json(res, {
      entries: rows.map(r => ({
        action: r.action, keyName: r.key_name, actor: r.actor,
        actorType: r.actor_type, createdAt: r.created_at,
      })),
    });
  }

  // ── Vault: Proxy (service-key or session auth) ──────────────────────
  if (pathname === '/api/vault/proxy' && req.method === 'POST') {
    const isService = verifyServiceKey(req);
    if (!isService && (!session || session.role !== 'super')) return json(res, { error: 'Forbidden' }, 403);

    try {
      const body = await readBody(req, 256 * 1024);
      const { keyName, url, method: reqMethod, headers: reqHeaders, bodyContent } = body;
      if (!keyName || !url) return json(res, { error: 'keyName and url are required' }, 400);

      const entry = vaultGet(keyName);
      if (!entry) return json(res, { error: `Vault key "${keyName}" not found` }, 404);

      const actor = isService ? (req.headers['x-anima-id'] || 'service') : session.username;
      vaultLog('proxy', keyName, actor, isService ? 'anima' : 'user');

      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      const outHeaders = { ...(reqHeaders || {}) };

      // Inject key based on common patterns
      const keyVal = entry.value;
      if (!outHeaders['Authorization'] && !outHeaders['authorization']) {
        if (/anthropic/i.test(keyName)) {
          outHeaders['x-api-key'] = keyVal;
          outHeaders['anthropic-version'] = outHeaders['anthropic-version'] || '2023-06-01';
        } else if (/X-Key|XI_/i.test(keyName)) {
          outHeaders['xi-api-key'] = keyVal;
        } else {
          outHeaders['Authorization'] = `Bearer ${keyVal}`;
        }
      } else {
        // Replace {{KEY}} placeholder in existing headers
        for (const [h, v] of Object.entries(outHeaders)) {
          if (typeof v === 'string' && v.includes('{{KEY}}')) {
            outHeaders[h] = v.replace('{{KEY}}', keyVal);
          }
        }
      }

      if (!outHeaders['Content-Type'] && bodyContent) {
        outHeaders['Content-Type'] = 'application/json';
      }

      const proxyResult = await new Promise((resolve) => {
        const proxyReq = proto.request(url, {
          method: (reqMethod || 'GET').toUpperCase(),
          headers: outHeaders,
          timeout: 60000,
        }, (proxyRes) => {
          let data = '';
          proxyRes.on('data', c => { data += c; });
          proxyRes.on('end', () => resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: data }));
        });
        proxyReq.on('error', (e) => resolve({ status: 502, body: JSON.stringify({ error: e.message }) }));
        proxyReq.on('timeout', () => { proxyReq.destroy(); resolve({ status: 504, body: '{"error":"Proxy timeout"}' }); });
        if (bodyContent) proxyReq.write(typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent));
        proxyReq.end();
      });

      res.writeHead(proxyResult.status, { 'Content-Type': proxyResult.headers?.['content-type'] || 'application/json' });
      res.end(proxyResult.body);
      return;
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // ── Vault: List keys (service-key auth, names only) ──────────────────
  if (pathname === '/api/vault/list' && req.method === 'GET') {
    if (!verifyServiceKey(req)) return json(res, { error: 'Forbidden — service key required' }, 403);
    const animaId = req.headers['x-anima-id'] || 'unknown';
    const all = vaultList();
    const keys = all
      .filter(k => k.scope === 'global' || k.scope.split(',').map(s => s.trim().toLowerCase()).includes(animaId.toLowerCase()))
      .map(k => ({ name: k.name, scope: k.scope, description: k.description }));
    return json(res, { keys });
  }

  // ── Vault: Key fetch (service-key auth, rate-limited) ───────────────
  if (pathname === '/api/vault/key' && req.method === 'GET') {
    if (!verifyServiceKey(req)) return json(res, { error: 'Forbidden — service key required' }, 403);

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const keyName = reqUrl.searchParams.get('name');
    if (!keyName) return json(res, { error: 'name query parameter required' }, 400);

    const animaId = req.headers['x-anima-id'] || 'unknown';

    // Rate limiting: max 30 key fetches per minute per anima
    const rlKey = `vault:${animaId}`;
    if (!vaultRateLimits.has(rlKey)) vaultRateLimits.set(rlKey, { count: 0, resetAt: Date.now() + 60000 });
    const rl = vaultRateLimits.get(rlKey);
    if (Date.now() > rl.resetAt) { rl.count = 0; rl.resetAt = Date.now() + 60000; }
    rl.count++;
    if (rl.count > 30) return json(res, { error: 'Rate limited — too many key requests' }, 429);

    const entry = vaultGet(keyName);
    if (!entry) return json(res, { error: `Key "${keyName}" not found` }, 404);

    // Scope check: if key is scoped to specific animas, enforce it
    if (entry.scope !== 'global') {
      const allowed = entry.scope.split(',').map(s => s.trim().toLowerCase());
      if (!allowed.includes(animaId.toLowerCase())) {
        vaultLog('denied', keyName, animaId, 'anima');
        return json(res, { error: `Key "${keyName}" not available for ${animaId}` }, 403);
      }
    }

    vaultLog('fetch', keyName, animaId, 'anima');
    return json(res, { name: entry.name, value: entry.value, ttl: 60 });
  }

  // ── LLM Providers: Admin CRUD (super only) ────────────────────────
  if (pathname === '/api/providers' || pathname.startsWith('/api/providers/')) {
    const provName = pathname.replace('/api/providers/', '').replace('/api/providers', '') || null;

    // GET /api/providers/config — service-key auth, returns decrypted config for calling anima
    if (pathname === '/api/providers/config' && req.method === 'GET') {
      if (!verifyServiceKey(req)) return json(res, { error: 'Forbidden — service key required' }, 403);
      const animaId = req.headers['x-anima-id'] || 'unknown';
      const config = providerConfigForAnima(animaId);
      return json(res, { providers: config });
    }

    // POST /api/providers/test — discover models + ping each one for status
    if (pathname === '/api/providers/test' && req.method === 'POST') {
      if (session.role !== 'super') return json(res, { error: 'Forbidden — super role required' }, 403);
      try {
        const body = await readBody(req);

        let testUrl = (body.url || '').replace(/\/$/, '');
        let authHeader = (body.authHeader || 'bearer').toLowerCase();
        let effectiveKey = body.key || '';
        if (body.name) {
          const existing = providerGet(body.name);
          if (existing) {
            if (!testUrl) testUrl = existing.url;
            if (!effectiveKey) effectiveKey = existing.key || '';
            if (!body.authHeader) authHeader = existing.authHeader || 'bearer';
          }
        }
        if (!testUrl) return json(res, { error: 'url required' }, 400);

        const buildHeaders = () => {
          const h = {};
          if (effectiveKey) {
            if (authHeader === 'bearer') h['Authorization'] = `Bearer ${effectiveKey}`;
            else h[authHeader] = effectiveKey;
          }
          return h;
        };

        const httpFetch = (urlStr, opts = {}) => {
          const proto = urlStr.startsWith('https') ? require('https') : require('http');
          const urlObj = new URL(urlStr);
          return new Promise((resolve) => {
            const r = proto.request({
              hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
              path: urlObj.pathname + urlObj.search,
              method: opts.method || 'GET',
              headers: { ...buildHeaders(), ...(opts.headers || {}) },
              timeout: opts.timeout || 5000,
            }, (resp) => {
              let d = '';
              resp.on('data', c => { d += c; });
              resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
            });
            r.on('error', (e) => resolve({ status: 0, body: e.message, error: true }));
            r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', error: true }); });
            if (opts.body) r.write(opts.body);
            r.end();
          });
        };

        // Step 1: Fetch model list
        const modelsResp = await httpFetch(`${testUrl}/models`, { timeout: 15000 });
        if (modelsResp.error || modelsResp.status === 0) {
          return json(res, { ok: false, message: `Connection failed: ${modelsResp.body}` });
        }
        if (modelsResp.status === 401 || modelsResp.status === 403) {
          return json(res, { ok: false, message: `Auth failed (HTTP ${modelsResp.status}) — check API key and auth header` });
        }
        if (modelsResp.status === 404) {
          return json(res, { ok: false, message: 'Endpoint not found (404) — check the base URL' });
        }
        if (modelsResp.status < 200 || modelsResp.status >= 300) {
          return json(res, { ok: false, message: `HTTP ${modelsResp.status}: ${modelsResp.body.substring(0, 200)}` });
        }

        let modelList = [];
        try {
          const parsed = JSON.parse(modelsResp.body);
          modelList = (parsed.data || []).map(m => m.id || m.name).filter(Boolean);
        } catch {
          return json(res, { ok: false, message: `Connected but /models returned invalid JSON` });
        }

        if (modelList.length === 0) {
          return json(res, { ok: true, message: 'Connected — no models listed', models: [] });
        }

        // Step 2: Capability heuristics
        const visionRe = /\bvl\b|vision|pixtral|4o|4v/i;
        const audioRe  = /audio|realtime|4o-audio/i;
        const videoRe  = /\bvl\b|video/i;

        // Step 3: Ping each model in parallel (max_tokens:1, 30s timeout for large local models)
        const pingResults = await Promise.all(modelList.map(async (modelId) => {
          const caps = {
            tools:  true,
            vision: visionRe.test(modelId),
            audio:  audioRe.test(modelId),
            video:  videoRe.test(modelId),
          };
          const pingBody = JSON.stringify({
            model: modelId, max_tokens: 1, stream: false,
            messages: [{ role: 'user', content: 'hi' }],
          });
          const pingResp = await httpFetch(`${testUrl}/chat/completions`, {
            method: 'POST', timeout: 30000,
            headers: { 'Content-Type': 'application/json' },
            body: pingBody,
          });
          let status = 'offline';
          let detail = '';
          if (pingResp.error || pingResp.status === 0) {
            detail = pingResp.body === 'timeout' ? 'timeout' : pingResp.body;
          } else if (pingResp.status >= 200 && pingResp.status < 300) {
            status = 'online';
          } else if (pingResp.status === 400) {
            // 400 could mean vLLM upstream error (model not loaded) or validation issue
            // Check if it's a vLLM upstream error vs a schema issue
            if (/upstream|not found|not loaded/i.test(pingResp.body)) {
              detail = 'not loaded';
            } else {
              status = 'online';
              detail = 'reachable (400 on test payload)';
            }
          } else if (pingResp.status === 422) {
            status = 'online';
            detail = 'reachable';
          } else if (pingResp.status === 503) {
            detail = 'unavailable (503)';
          } else {
            detail = `HTTP ${pingResp.status}`;
          }
          return { id: modelId, status, detail, caps };
        }));

        const onlineCount = pingResults.filter(m => m.status === 'online').length;
        return json(res, {
          ok: true,
          message: `Connected — ${modelList.length} model(s) found, ${onlineCount} online`,
          models: pingResults,
        });
      } catch (e) { return json(res, { ok: false, message: e.message }, 200); }
    }

    // Everything else requires super
    if (session.role !== 'super') return json(res, { error: 'Forbidden — super role required' }, 403);

    if (req.method === 'GET' && !provName) {
      const providers = providerList().map(p => ({
        name: p.name, url: p.url, authHeader: p.auth_header,
        scope: p.scope, description: p.description,
        createdAt: p.created_at, updatedAt: p.updated_at, hasKey: !!(p.encrypted_key || p.iv),
      }));
      return json(res, { providers });
    }

    if (req.method === 'POST' && !provName) {
      try {
        const body = await readBody(req);
        const { name, url, key, authHeader, scope, description } = body;
        if (!name || !url) return json(res, { error: 'name and url required' }, 400);
        if (!/^[a-z][a-z0-9_]*$/i.test(name)) return json(res, { error: 'name must be alphanumeric (e.g. together, groq)' }, 400);
        providerSet(name.toLowerCase(), { url, key, authHeader, scope, description });
        vaultLog('set', `provider:${name}`, session.username || 'admin');
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }

    if (req.method === 'DELETE' && provName) {
      const ok = providerDelete(decodeURIComponent(provName));
      if (ok) vaultLog('delete', `provider:${provName}`, session.username || 'admin');
      return json(res, ok ? { ok: true } : { error: 'Not found' }, ok ? 200 : 404);
    }
  }

  // ── Shared Projects CRUD (super only, or service-key for reads) ──
  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
    const isServiceKey = verifyServiceKey(req);
    if (!isServiceKey && session.role !== 'super') {
      return json(res, { error: 'Forbidden' }, 403);
    }

    const projects = loadProjects();
    const projectSlug = pathname.split('/api/projects/')[1]?.split('/')[0];
    const subPath = pathname.split(`/api/projects/${projectSlug}/`)[1];

    // GET /api/projects — list all projects (or filtered for an anima via service-key)
    if (pathname === '/api/projects' && req.method === 'GET') {
      const animaId = req.headers['x-anima-id'];
      if (isServiceKey && animaId) {
        const filtered = {};
        for (const [slug, proj] of Object.entries(projects)) {
          if (proj.members && proj.members.includes(animaId)) filtered[slug] = proj;
        }
        return json(res, { projects: filtered });
      }
      return json(res, { projects });
    }

    // POST /api/projects — create a project
    if (pathname === '/api/projects' && req.method === 'POST') {
      if (isServiceKey && session.role !== 'super') return json(res, { error: 'Write requires super role' }, 403);
      try {
        const body = await readBody(req);
        if (!body.slug) return json(res, { error: 'slug required' }, 400);
        const slug = body.slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!slug || slug.startsWith('_')) return json(res, { error: 'Invalid slug (alphanumeric, hyphens, underscores only)' }, 400);
        if (projects[slug]) return json(res, { error: 'Project already exists' }, 409);

        const dbFile = path.join(SHARED_GRAPHS_DIR, `${slug}.db`);
        seedProjectGraph(dbFile);

        projects[slug] = {
          name: body.name || slug,
          description: body.description || '',
          members: body.members || [],
          created: new Date().toISOString(),
          dbFile: `${slug}.db`,
        };
        saveProjects(projects);
        return json(res, { ok: true, project: projects[slug] }, 201);
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    if (projectSlug && projects[projectSlug]) {
      const proj = projects[projectSlug];

      // GET /api/projects/:slug
      if (!subPath && req.method === 'GET') {
        return json(res, { project: proj });
      }

      // PUT /api/projects/:slug — update project metadata/members
      if (!subPath && req.method === 'PUT') {
        if (isServiceKey && session.role !== 'super') return json(res, { error: 'Write requires super role' }, 403);
        try {
          const body = await readBody(req);
          if (body.name !== undefined) proj.name = body.name;
          if (body.description !== undefined) proj.description = body.description;
          if (body.members !== undefined) proj.members = body.members;
          proj.updated = new Date().toISOString();
          projects[projectSlug] = proj;
          saveProjects(projects);
          return json(res, { ok: true, project: proj });
        } catch (e) { return json(res, { error: e.message }, 500); }
      }

      // DELETE /api/projects/:slug
      if (!subPath && req.method === 'DELETE') {
        if (isServiceKey && session.role !== 'super') return json(res, { error: 'Write requires super role' }, 403);
        const dbFile = path.join(SHARED_GRAPHS_DIR, proj.dbFile || `${projectSlug}.db`);
        try { fs.unlinkSync(dbFile); } catch {}
        try { fs.unlinkSync(dbFile + '-wal'); } catch {}
        try { fs.unlinkSync(dbFile + '-shm'); } catch {}
        delete projects[projectSlug];
        saveProjects(projects);
        return json(res, { ok: true });
      }
    } else if (projectSlug) {
      return json(res, { error: 'Project not found' }, 404);
    }
  }

  // ── User management (super only) ─────────────────────────────────
  if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
    if (session.role !== 'super') {
      return json(res, { error: 'Forbidden' }, 403);
    }

    // GET /api/users — list all users
    if (pathname === '/api/users' && req.method === 'GET') {
      const users = loadUsers().map(u => ({
        username: u.username,
        role: u.role,
        createdAt: u.createdAt,
        authProvider: u.authProvider || 'password',
        googleName: u.googleName || null,
      }));
      return json(res, { users });
    }

    // POST /api/users — create a user
    if (pathname === '/api/users' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.username || !body.password) {
          return json(res, { error: 'username and password required' }, 400);
        }
        if (!/^[a-z0-9_-]{2,32}$/.test(body.username)) {
          return json(res, { error: 'username must be 2-32 lowercase alphanumeric chars, underscores or hyphens' }, 400);
        }
        if (body.password.length < 12) {
          return json(res, { error: 'Password must be at least 12 characters' }, 400);
        }
        if (!/[a-z]/.test(body.password) || !/[A-Z]/.test(body.password) || !/[0-9]/.test(body.password)) {
          return json(res, { error: 'Password must contain lowercase, uppercase, and a number' }, 400);
        }
        const users = loadUsers();
        if (users.find(u => u.username === body.username)) {
          return json(res, { error: `User '${body.username}' already exists` }, 409);
        }
        const { salt, hash } = createPasswordHash(body.password);
        users.push({
          username: body.username,
          salt,
          hash,
          role: body.role === 'super' ? 'super' : 'user',
          createdAt: new Date().toISOString(),
        });
        saveUsers(users);
        return json(res, { ok: true, username: body.username }, 201);
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    // PUT /api/users/:username — update password or role
    const userPutMatch = pathname.match(/^\/api\/users\/([a-zA-Z0-9_.@%+-]+)$/);
    if (userPutMatch && req.method === 'PUT') {
      try {
        const targetUsername = decodeURIComponent(userPutMatch[1]);
        const body = await readBody(req);
        const users = loadUsers();
        const idx = users.findIndex(u => u.username === targetUsername);
        if (idx === -1) return json(res, { error: 'User not found' }, 404);
        if (body.password) {
          if (users[idx].authProvider === 'google') {
            return json(res, { error: 'Cannot set password for Google-authenticated users' }, 400);
          }
          const { salt, hash } = createPasswordHash(body.password);
          users[idx].salt = salt;
          users[idx].hash = hash;
        }
        if (body.role && (body.role === 'super' || body.role === 'user')) {
          users[idx].role = body.role;
        }
        saveUsers(users);
        // Invalidate all sessions for this user
        for (const [tok, sess] of sessions) {
          if (sess.username === targetUsername) sessions.delete(tok);
        }
        return json(res, { ok: true });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    // DELETE /api/users/:username
    if (userPutMatch && req.method === 'DELETE') {
      try {
        const targetUsername = decodeURIComponent(userPutMatch[1]);
        if (targetUsername === session.username) {
          return json(res, { error: 'Cannot delete your own account' }, 400);
        }
        const users = loadUsers().filter(u => u.username !== targetUsername);
        saveUsers(users);
        for (const [tok, sess] of sessions) {
          if (sess.username === targetUsername) sessions.delete(tok);
        }
        return json(res, { ok: true });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }
  }

  // ── Route: /api/animas/:id/* ───────────────────────────────────────
  const animaMatch = pathname.match(/^\/api\/animas\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/);
  if (!animaMatch) {
    return json(res, { error: 'Not found' }, 404);
  }

  const animaId = animaMatch[1];
  const subRoute = animaMatch[2] || '';
  const animaDir = getAnimaDir(animaId);

  if (!animaDir) {
    return json(res, { error: `${brand.Agent} '${animaId}' not found` }, 404);
  }

  // Ownership check: regular users can only access their own animas
  if (session.role !== 'super') {
    const agentEnv = parseEnvFile(path.join(animaDir, '.env'));
    const agentOwner = agentEnv.ANIMA_OWNER || null;
    if (agentOwner !== session.username) {
      return json(res, { error: 'Forbidden' }, 403);
    }
  }

  // DELETE /api/animas/:id
  if (!subRoute && req.method === 'DELETE') {
    try {
      // Signal the host watcher to stop container + remove directory
      // The watcher handles docker compose down and full cleanup (including UID 2000 files)
      fs.writeFileSync(path.join(animaDir, '.stop'), JSON.stringify({ delete: true, ts: Date.now() }));
      return json(res, { ok: true, message: `${brand.Agent} '${animaId}' queued for removal` });
    } catch (e) {
      return json(res, { error: `Delete failed: ${e.message}` }, 500);
    }
  }

  // GET /api/animas/:id
  if (!subRoute && req.method === 'GET') {
    const envPath = path.join(animaDir, '.env');
    const configPath = path.join(animaDir, 'anima.json');
    const env = parseEnvFile(envPath);
    const maskedEnv = maskSensitive(env);
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

    const stopped = fs.existsSync(path.join(animaDir, '.stopped'));
    return json(res, { id: animaId, env: maskedEnv, config, rawEnvKeys: Object.keys(env), stopped });
  }

  // PUT /api/animas/:id/env
  if (subRoute === 'env' && req.method === 'PUT') {
    try {
      const body = await readBody(req);
      if (!body.env || typeof body.env !== 'object') {
        return json(res, { error: 'Missing env object' }, 400);
      }

      const envPath = path.join(animaDir, '.env');
      const current = parseEnvFile(envPath);

      const currentMasked = maskSensitive(current);
      for (const [key, value] of Object.entries(body.env)) {
        if (!isAllowedEnvKey(key)) continue;
        if (value === null || value === '') {
          delete current[key];
        } else {
          const strVal = String(value);
          if (SENSITIVE_KEYS.has(key) && strVal === currentMasked[key]) continue;
          if (validateEnvValue(strVal)) {
            current[key] = strVal;
          }
        }
      }

      writeEnvFile(envPath, current);
      return json(res, { ok: true, message: 'Environment updated' });
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  }

  // PUT /api/animas/:id/config
  if (subRoute === 'config' && req.method === 'PUT') {
    try {
      const body = await readBody(req);
      if (!body.config || typeof body.config !== 'object') {
        return json(res, { error: 'Missing config object' }, 400);
      }

      const configPath = path.join(animaDir, 'anima.json');
      let current = {};
      try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

      const ALLOWED_CONFIG = [
        'displayName', 'nicknames', 'guilds', 'listenChannels', 'privacy', 'channels', 'superAgent',
        'dmMaxIterations', 'maxSubagentChildren', 'subagentMaxIter',
        'subagentTimeoutSeconds', 'maxTokens', 'tokenBudgetPressure',
        'lullMaxIterations', 'maxConcurrent', 'maxSessionMessages',
      ];
      for (const key of ALLOWED_CONFIG) {
        if (body.config[key] !== undefined) {
          if (body.config[key] === null) {
            delete current[key];
          } else {
            current[key] = body.config[key];
          }
        }
      }
      if (body.config.loopDetection && typeof body.config.loopDetection === 'object') {
        if (!current.loopDetection) current.loopDetection = {};
        for (const [k, v] of Object.entries(body.config.loopDetection)) {
          if (v === null) delete current.loopDetection[k];
          else current.loopDetection[k] = v;
        }
      }

      // Proactive settings → persisted in .env (not anima.json)
      const PROACTIVE_ENV_MAP = {
        proactiveEnabled: 'ANIMA_PROACTIVE_ENABLED',
        proactiveCooldown: 'ANIMA_PROACTIVE_COOLDOWN',
        proactiveMaxDay: 'ANIMA_PROACTIVE_MAX_DAY',
        proactiveChannels: 'ANIMA_PROACTIVE_CHANNELS',
      };
      const envUpdates = {};
      for (const [cfgKey, envKey] of Object.entries(PROACTIVE_ENV_MAP)) {
        if (body.config[cfgKey] !== undefined) {
          const val = String(body.config[cfgKey]);
          if (!validateEnvValue(val)) continue;
          envUpdates[envKey] = val;
        }
      }
      if (Object.keys(envUpdates).length > 0) {
        const envFilePath = path.join(animaDir, '.env');
        const envCurrent = parseEnvFile(envFilePath);
        for (const [k, v] of Object.entries(envUpdates)) {
          if (v === '' || v === 'false' || v === 'null') {
            delete envCurrent[k];
          } else {
            envCurrent[k] = v;
          }
        }
        writeEnvFile(envFilePath, envCurrent);
      }

      fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + '\n');

      // Mirror to src/anima.json if present
      const srcConfig = path.join(animaDir, 'src', 'anima.json');
      if (fs.existsSync(srcConfig)) {
        fs.writeFileSync(srcConfig, JSON.stringify(current, null, 2) + '\n');
      }

      return json(res, { ok: true, message: 'Config updated' });
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  }

  // GET /api/animas/:id/health
  if (subRoute === 'health' && req.method === 'GET') {
    const health = await proxyHealth(animaId);
    return json(res, health);
  }

  // GET /api/animas/:id/tokens
  if (subRoute === 'tokens' && req.method === 'GET') {
    const tokens = await proxyTokens(animaId, animaDir);
    return json(res, tokens);
  }

  // GET /api/animas/:id/lull — read lull_behavior from graph
  if (subRoute === 'lull' && req.method === 'GET') {
    try {
      const dbPath = resolveGraphDb(animaDir);
      if (!dbPath) return json(res, { lines: [] });
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const agentId = (parseEnvFile(path.join(animaDir, '.env')).AGENT_ID || animaId).trim();
      const rows = db.prepare(`
        SELECT at.id, at.content, at.importance FROM attributes at
        JOIN aspects a ON at.aspect_id = a.id
        WHERE a.node_id = ? AND a.name = 'lull_behavior'
        ORDER BY at.importance DESC
      `).all(agentId);
      db.close();
      return json(res, { lines: rows });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // PUT /api/animas/:id/lull — write lull_behavior to graph
  if (subRoute === 'lull' && req.method === 'PUT') {
    try {
      const body = await readBody(req);
      if (!body.lines || !Array.isArray(body.lines)) return json(res, { error: 'Missing lines array' }, 400);
      const dbPath = resolveGraphDb(animaDir);
      if (!dbPath) return json(res, { error: 'No graph database found' }, 404);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      const agentId = (parseEnvFile(path.join(animaDir, '.env')).AGENT_ID || animaId).trim();

      // Ensure aspect exists
      db.prepare(`INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
        SELECT ?, 'lull_behavior', 8, 'manager'
        WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = ? AND name = 'lull_behavior')`).run(agentId, agentId);
      const aspectRow = db.prepare(`SELECT id FROM aspects WHERE node_id = ? AND name = 'lull_behavior'`).get(agentId);
      if (!aspectRow) { db.close(); return json(res, { error: 'Failed to find/create aspect' }, 500); }
      const aspectId = aspectRow.id;

      // Replace all attributes in this aspect
      db.prepare(`DELETE FROM attributes WHERE aspect_id = ?`).run(aspectId);
      const ins = db.prepare(`INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, 'manager', 'manager')`);
      for (const line of body.lines) {
        if (typeof line.content === 'string' && line.content.trim()) {
          ins.run(aspectId, line.content.trim(), line.importance || 8);
        }
      }
      db.close();
      return json(res, { ok: true, message: 'Lull behavior updated' });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // GET /api/animas/:id/graph — read another anima's graph (search or node lookup)
  if (subRoute === 'graph' && req.method === 'GET') {
    try {
      const dbPath = resolveGraphDb(animaDir);
      if (!dbPath) return json(res, { error: 'No graph database found' }, 404);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });

      const url = new URL(req.url, 'http://localhost');
      const query = url.searchParams.get('query');
      const nodeId = url.searchParams.get('nodeId');
      const type = url.searchParams.get('type');

      let result;
      if (nodeId) {
        const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
        if (!node) { db.close(); return json(res, { error: 'Node not found' }, 404); }
        const aspects = db.prepare('SELECT * FROM aspects WHERE node_id = ?').all(nodeId);
        for (const a of aspects) {
          a.attributes = db.prepare('SELECT id, content, importance FROM attributes WHERE aspect_id = ?').all(a.id);
        }
        node.aspects = aspects;
        node.edges = db.prepare('SELECT * FROM edges WHERE source = ? OR target = ?').all(nodeId, nodeId);
        result = { node };
      } else if (query) {
        const like = `%${query}%`;
        let sql = 'SELECT id, label, type, description, importance, mentions FROM nodes WHERE (LOWER(label) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) OR LOWER(id) LIKE LOWER(?))';
        const params = [like, like, like];
        if (type) { sql += ' AND type = ?'; params.push(type); }
        sql += ' ORDER BY importance DESC, mentions DESC LIMIT 20';
        result = { nodes: db.prepare(sql).all(...params) };
      } else if (type) {
        result = { nodes: db.prepare('SELECT id, label, type, description, importance, mentions FROM nodes WHERE type = ? ORDER BY importance DESC LIMIT 50').all(type) };
      } else {
        const stats = {
          nodes: db.prepare('SELECT COUNT(*) as c FROM nodes').get().c,
          aspects: db.prepare('SELECT COUNT(*) as c FROM aspects').get().c,
          attributes: db.prepare('SELECT COUNT(*) as c FROM attributes').get().c,
          edges: db.prepare('SELECT COUNT(*) as c FROM edges').get().c,
        };
        result = { stats };
      }
      db.close();
      return json(res, result);
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // POST /api/animas/:id/graph — write to another anima's graph
  if (subRoute === 'graph' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body || !body.nodeId) return json(res, { error: 'Missing nodeId' }, 400);
      const dbPath = resolveGraphDb(animaDir);
      if (!dbPath) return json(res, { error: 'No graph database found' }, 404);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);

      const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(body.nodeId);
      if (!existing) {
        db.prepare('INSERT INTO nodes (id, label, type, description, importance, mentions, extracted_with) VALUES (?, ?, ?, ?, ?, 1, ?)').run(
          body.nodeId, body.label || body.nodeId, body.type || 'concept', body.description || '', body.importance || 5, 'orchestrator'
        );
      } else if (body.description) {
        db.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?').run(body.description, body.nodeId);
      }

      if (body.aspects && Array.isArray(body.aspects)) {
        for (const asp of body.aspects) {
          if (!asp.name) continue;
          let aspRow = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(body.nodeId, asp.name);
          if (!aspRow) {
            db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)').run(body.nodeId, asp.name, asp.importance || 5, 'orchestrator');
            aspRow = { id: db.prepare('SELECT last_insert_rowid() as id').get().id };
          }
          if (asp.attributes && Array.isArray(asp.attributes)) {
            for (const attr of asp.attributes) {
              const content = typeof attr === 'string' ? attr : attr.content;
              if (!content) continue;
              const dup = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(aspRow.id, content);
              if (!dup) {
                db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, ?, ?)').run(
                  aspRow.id, content, typeof attr === 'object' ? (attr.importance || 5) : 5, 'orchestrator', 'orchestrator'
                );
              }
            }
          }
        }
      }

      if (body.edges && Array.isArray(body.edges)) {
        for (const edge of body.edges) {
          if (!edge.target || !edge.type) continue;
          const edgeExists = db.prepare('SELECT id FROM edges WHERE source = ? AND target = ? AND type = ?').get(body.nodeId, edge.target, edge.type);
          if (!edgeExists) {
            db.prepare('INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, ?, ?)').run(
              body.nodeId, edge.target, edge.type, edge.weight || 1.0, 'orchestrator'
            );
          }
        }
      }

      db.close();
      return json(res, { ok: true, message: `Graph updated for ${animaId}` });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // GET /api/animas/:id/logs — read recent container log lines
  if (subRoute === 'logs' && req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      const logPath = path.join(animaDir, 'data', 'anima.log');
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const logLines = content.split('\n').slice(-Math.min(lines, 200));
        return json(res, { lines: logLines });
      }
      return json(res, { lines: [], note: 'No log file found. Container logs are in Docker.' });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // POST /api/animas/:id/restart
  if (subRoute === 'restart' && req.method === 'POST') {
    try {
      const body = await readBody(req).catch(() => ({}));
      let mode = 'rebuild';
      if (body.mode === 'recreate') mode = 'recreate';
      else if (body.mode === 'restart') mode = 'restart';
      else if (body.rebuild === false) mode = 'recreate';
      fs.writeFileSync(path.join(animaDir, RESTART_MARKER), JSON.stringify({ mode, ts: Date.now() }));
      const stoppedPath = path.join(animaDir, '.stopped');
      try { fs.rmSync(stoppedPath, { force: true }); } catch {}
      return json(res, { ok: true, message: `${animaId} ${mode} queued — watcher will pick it up shortly` });
    } catch (e) {
      return json(res, { error: `Failed to write restart marker: ${e.message}` }, 500);
    }
  }

  // POST /api/animas/:id/stop — spin down without deleting
  if (subRoute === 'stop' && req.method === 'POST') {
    try {
      fs.writeFileSync(path.join(animaDir, '.stop'), Date.now().toString());
      fs.writeFileSync(path.join(animaDir, '.stopped'), Date.now().toString());
      return json(res, { ok: true, message: `${animaId} stop queued — container will spin down shortly` });
    } catch (e) {
      return json(res, { error: `Failed to write stop marker: ${e.message}` }, 500);
    }
  }

  // POST /api/animas/:id/start — spin up a stopped anima
  if (subRoute === 'start' && req.method === 'POST') {
    try {
      const stoppedPath = path.join(animaDir, '.stopped');
      fs.writeFileSync(path.join(animaDir, RESTART_MARKER), JSON.stringify({ mode: 'rebuild', ts: Date.now() }));
      try { fs.rmSync(stoppedPath, { force: true }); } catch {}
      return json(res, { ok: true, message: `${animaId} start queued — container will spin up shortly` });
    } catch (e) {
      return json(res, { error: `Failed to write start marker: ${e.message}` }, 500);
    }
  }

  // GET /api/animas/:id/build-status — build/runtime status from watcher
  if (subRoute === 'build-status' && req.method === 'GET') {
    const statusPath = path.join(animaDir, '.build-status.json');
    try {
      if (fs.existsSync(statusPath)) {
        const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        return json(res, raw);
      }
      return json(res, { state: 'unknown' });
    } catch (e) {
      return json(res, { state: 'unknown', error: e.message });
    }
  }

  // ── Plugin Management (super only) ─────────────────────────────────

  // GET /api/animas/:id/plugins — list installed plugins
  if (subRoute === 'plugins' && req.method === 'GET') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    try {
      const pluginsDir = path.join(animaDir, 'workspace', 'plugins');
      if (!fs.existsSync(pluginsDir)) return json(res, { plugins: [] });
      const dirs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      const plugins = [];
      for (const d of dirs) {
        const pDir = path.join(pluginsDir, d.name);
        let manifest = null;
        for (const mf of ['anima.plugin.json', 'openclaw.plugin.json', 'package.json']) {
          const mfPath = path.join(pDir, mf);
          if (fs.existsSync(mfPath)) {
            try {
              const raw = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
              if (mf === 'package.json') {
                const meta = raw.anima || raw.openclaw;
                if (meta?.kind) manifest = { id: meta.id || raw.name, name: meta.name || raw.name, version: raw.version, kind: meta.kind, openclawCompat: !!raw.openclaw };
              } else {
                manifest = { id: raw.id, name: raw.name || raw.id, version: raw.version || '0.0.0', kind: raw.kind, openclawCompat: mf === 'openclaw.plugin.json' };
              }
            } catch {}
            if (manifest) break;
          }
        }
        plugins.push(manifest || { id: d.name, name: d.name, version: '?', kind: 'unknown', openclawCompat: false });
      }
      return json(res, { plugins });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // POST /api/animas/:id/plugins — install a plugin
  if (subRoute === 'plugins' && req.method === 'POST') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    try {
      const body = await readBody(req);
      const { source, package: pkg } = body;
      if (!pkg || typeof pkg !== 'string') return json(res, { error: 'Missing "package" field' }, 400);
      if (/[`$\\!;|&(){}<>]/.test(pkg)) return json(res, { error: 'Invalid characters in package name' }, 400);
      if (pkg.length > 200) return json(res, { error: 'Package name too long' }, 400);
      const pluginsDir = path.join(animaDir, 'workspace', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      const { execFileSync } = require('child_process');

      if (source === 'npm') {
        const safeName = pkg.replace(/[^a-zA-Z0-9@/_.-]/g, '');
        const dirName = safeName.replace(/\//g, '-').replace(/^@/, '');
        execFileSync('npm', ['pack', safeName, '--pack-destination', pluginsDir], { cwd: pluginsDir, timeout: 60000, stdio: 'pipe' });
        const tgzFiles = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.tgz'));
        if (tgzFiles.length === 0) throw new Error('npm pack produced no output');
        const tgz = path.join(pluginsDir, tgzFiles[0]);
        const dest = path.join(pluginsDir, dirName);
        fs.mkdirSync(dest, { recursive: true });
        execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { timeout: 30000, stdio: 'pipe' });
        fs.unlinkSync(tgz);
      } else if (source === 'git') {
        if (!/^https?:\/\//.test(pkg) && !pkg.includes('@')) return json(res, { error: 'Git source must be an HTTPS URL' }, 400);
        const dirName = path.basename(pkg).replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '');
        if (!dirName) return json(res, { error: 'Cannot derive directory name from URL' }, 400);
        execFileSync('git', ['clone', '--depth', '1', pkg, path.join(pluginsDir, dirName)], { timeout: 60000, stdio: 'pipe' });
      } else {
        return json(res, { error: 'Unsupported source. Use "npm" or "git".' }, 400);
      }

      fs.writeFileSync(path.join(animaDir, RESTART_MARKER), JSON.stringify({ mode: 'restart', ts: Date.now() }));
      return json(res, { ok: true, message: `Plugin installed from ${source}. Agent restart queued.` }, 201);
    } catch (e) {
      return json(res, { error: `Install failed: ${e.message}` }, 500);
    }
  }

  // DELETE /api/animas/:id/plugins/:pluginId — remove a plugin
  const pluginDeleteMatch = subRoute?.match(/^plugins\/([a-zA-Z0-9_@-]+)$/);
  if (pluginDeleteMatch && req.method === 'DELETE') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    try {
      const pluginId = pluginDeleteMatch[1];
      const pluginsBase = path.join(animaDir, 'workspace', 'plugins');
      const pluginDir = path.resolve(pluginsBase, pluginId);
      if (!pluginDir.startsWith(pluginsBase + path.sep)) return json(res, { error: 'Invalid plugin ID' }, 400);
      if (!fs.existsSync(pluginDir) || !fs.statSync(pluginDir).isDirectory()) return json(res, { error: 'Plugin not found' }, 404);
      fs.rmSync(pluginDir, { recursive: true, force: true });
      fs.writeFileSync(path.join(animaDir, RESTART_MARKER), JSON.stringify({ mode: 'restart', ts: Date.now() }));
      return json(res, { ok: true, message: `Plugin "${pluginId}" removed. Agent restart queued.` });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // GET /api/animas/:id/plugins/:pluginId/config — read plugin config
  const pluginConfigMatch = subRoute?.match(/^plugins\/([a-zA-Z0-9_@-]+)\/config$/);
  if (pluginConfigMatch && req.method === 'GET') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    try {
      const pluginId = pluginConfigMatch[1];
      const configPath = path.join(animaDir, 'anima.json');
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      return json(res, { config: config.plugins?.[pluginId] || {} });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // PUT /api/animas/:id/plugins/:pluginId/config — write plugin config
  if (pluginConfigMatch && req.method === 'PUT') {
    if (session.role !== 'super') return json(res, { error: 'Forbidden' }, 403);
    try {
      const pluginId = pluginConfigMatch[1];
      const body = await readBody(req);
      const configPath = path.join(animaDir, 'anima.json');
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
      if (!config.plugins) config.plugins = {};
      config.plugins[pluginId] = body.config || {};
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      fs.writeFileSync(path.join(animaDir, RESTART_MARKER), JSON.stringify({ mode: 'restart', ts: Date.now() }));
      return json(res, { ok: true, message: `Config updated for "${pluginId}". Agent restart queued.` });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── Webapp Users (per-anima) ──────────────────────────────────────

  const webappUsersMatch = subRoute?.match(/^webapp-users(?:\/(.+))?$/);
  if (webappUsersMatch) {
    const dataDir = path.join(animaDir, 'data');
    const wuFile = path.join(dataDir, 'webapp-users.json');

    const loadWU = () => {
      try { return JSON.parse(fs.readFileSync(wuFile, 'utf8')); } catch { return []; }
    };
    const saveWU = (users) => {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(wuFile, JSON.stringify(users, null, 2) + '\n');
      try { fs.chownSync(wuFile, 2000, 2000); } catch {}
    };

    if (req.method === 'GET') {
      const users = loadWU().map(u => ({ username: u.username, createdAt: u.createdAt }));
      return json(res, { users });
    }

    if (req.method === 'POST' && !webappUsersMatch[1]) {
      try {
        const body = await readBody(req);
        if (!body.username || !body.password) return json(res, { error: 'Username and password required' }, 400);
        const uname = body.username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (uname.length < 2) return json(res, { error: 'Username must be at least 2 characters (alphanumeric)' }, 400);
        if (body.password.length < 12) return json(res, { error: 'Password must be at least 12 characters' }, 400);
        if (!/[a-z]/.test(body.password) || !/[A-Z]/.test(body.password) || !/[0-9]/.test(body.password))
          return json(res, { error: 'Password must contain lowercase, uppercase, and a number' }, 400);
        const users = loadWU();
        if (users.find(u => u.username === uname)) return json(res, { error: 'User already exists' }, 409);
        const { salt, hash } = createPasswordHash(body.password);
        users.push({ username: uname, salt, hash, createdAt: new Date().toISOString() });
        saveWU(users);
        return json(res, { ok: true, username: uname });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }

    if (req.method === 'DELETE' && webappUsersMatch[1]) {
      const target = decodeURIComponent(webappUsersMatch[1]);
      const users = loadWU();
      const idx = users.findIndex(u => u.username === target);
      if (idx === -1) return json(res, { error: 'User not found' }, 404);
      users.splice(idx, 1);
      saveWU(users);
      return json(res, { ok: true });
    }
  }

  return json(res, { error: 'Not found' }, 404);
}

// ── Chatroom WebSocket Hub ───────────────────────────────────────────

const WebSocket = require('ws');

const CHATROOM_DB_PATH = path.join(ANIMAS_DIR, '.chatroom.db');
const CHATROOM_HISTORY_LIMIT = 200;
const UPLOADS_DIR = path.join(ANIMAS_DIR, '.chatroom-uploads');

let chatroomDb;
function getChatroomDb() {
  if (chatroomDb) return chatroomDb;
  const { DatabaseSync } = require('node:sqlite');
  chatroomDb = new DatabaseSync(CHATROOM_DB_PATH);
  chatroomDb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      media_url TEXT,
      media_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);
  return chatroomDb;
}

const chatroomClients = new Set();

function chatroomBroadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  for (const client of chatroomClients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  }
}

function chatroomPersistAndBroadcast(authorId, authorName, authorType, content, mediaUrl, mediaType) {
  const db = getChatroomDb();
  const stmt = db.prepare(
    'INSERT INTO messages (author_id, author_name, author_type, content, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(authorId, authorName, authorType, content, mediaUrl || null, mediaType || null);
  const row = db.prepare('SELECT * FROM messages WHERE rowid = last_insert_rowid()').get();
  const msg = {
    type: 'chat',
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorType: row.author_type,
    content: row.content,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    createdAt: row.created_at,
  };
  chatroomBroadcast(msg);
  return msg;
}

function handleChatroomUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws/chatroom') return false;

  const svcKey = req.headers['x-service-key'];
  const isService = MANAGER_SERVICE_KEY && svcKey
    && svcKey.length === MANAGER_SERVICE_KEY.length
    && crypto.timingSafeEqual(Buffer.from(svcKey), Buffer.from(MANAGER_SERVICE_KEY));

  let wsUser = null;
  let wsUserId = null;
  let wsAuthorType = 'user';

  if (isService) {
    wsUserId = req.headers['x-agent-id'] || 'anima';
    wsUser = req.headers['x-agent-name'] || wsUserId;
    wsAuthorType = 'anima';
  } else {
    const cookie = (req.headers.cookie || '').split(';').map(c => c.trim());
    const sessionCookie = cookie.find(c => c.startsWith('manager_session='));
    if (sessionCookie) {
      const token = sessionCookie.split('=')[1];
      const sess = sessions.get(token);
      if (sess && Date.now() - sess.created <= SESSION_TTL_MS) {
        wsUserId = sess.username;
        wsUser = sess.username;
        wsAuthorType = 'user';
      }
    }
  }

  if (!wsUser) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }

  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._userId = wsUserId;
    ws._userName = wsUser;
    ws._authorType = wsAuthorType;
    chatroomClients.add(ws);

    console.log(`[chatroom] ${wsAuthorType} "${wsUser}" connected (${chatroomClients.size} total)`);

    // Send recent history
    try {
      const db = getChatroomDb();
      const rows = db.prepare(
        `SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ${CHATROOM_HISTORY_LIMIT}) ORDER BY id ASC`
      ).all();
      ws.send(JSON.stringify({
        type: 'history',
        messages: rows.map(r => ({
          id: r.id, authorId: r.author_id, authorName: r.author_name,
          authorType: r.author_type, content: r.content,
          mediaUrl: r.media_url, mediaType: r.media_type, createdAt: r.created_at,
        })),
      }));
    } catch (e) {
      console.error('[chatroom] History load error:', e.message);
    }

    // Send current participants
    for (const c of chatroomClients) {
      if (c !== ws && c.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'presence', id: c._userId, name: c._userName, authorType: c._authorType }));
      }
    }
    chatroomBroadcast({ type: 'presence', id: wsUserId, name: wsUser, authorType: wsAuthorType }, ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'chat' && msg.content && typeof msg.content === 'string') {
          const content = msg.content.substring(0, 8000);
          chatroomPersistAndBroadcast(wsUserId, wsUser, wsAuthorType, content, msg.mediaUrl, msg.mediaType);
        } else if (msg.type === 'typing') {
          chatroomBroadcast({ type: 'typing', authorId: wsUserId, authorName: wsUser }, ws);
        } else if (msg.type === 'status') {
          chatroomBroadcast({ type: 'status', authorId: wsUserId, authorName: wsUser, status: msg.status }, ws);
        }
      } catch {}
    });

    ws.on('close', () => {
      chatroomClients.delete(ws);
      chatroomBroadcast({ type: 'leave', id: wsUserId, name: wsUser });
      console.log(`[chatroom] ${wsAuthorType} "${wsUser}" disconnected (${chatroomClients.size} total)`);
    });

    ws.on('error', () => {
      chatroomClients.delete(ws);
    });
  });
  return true;
}

// ── Start ────────────────────────────────────────────────────────────

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Chatroom file upload
    if (req.url?.startsWith('/api/chatroom/upload') && req.method === 'POST') {
      const session = validateSession(req);
      const svcKey = req.headers['x-service-key'];
      const isService = MANAGER_SERVICE_KEY && svcKey
        && svcKey.length === MANAGER_SERVICE_KEY.length
        && crypto.timingSafeEqual(Buffer.from(svcKey), Buffer.from(MANAGER_SERVICE_KEY));
      if (!session && !isService) {
        res.writeHead(401); res.end('Unauthorized'); return;
      }
      const chunks = [];
      let size = 0;
      const MAX_UPLOAD = 10 * 1024 * 1024;
      req.on('data', c => { size += c.length; if (size <= MAX_UPLOAD) chunks.push(c); });
      req.on('end', () => {
        if (size > MAX_UPLOAD) { res.writeHead(413); res.end('Too large'); return; }
        try {
          fs.mkdirSync(UPLOADS_DIR, { recursive: true });
          const ext = (req.headers['x-filename'] || 'file').split('.').pop().replace(/[^a-zA-Z0-9]/g, '') || 'bin';
          const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.concat(chunks));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: `/uploads/${name}`, name }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Chatroom history API
    if (req.url?.startsWith('/api/chatroom/history') && req.method === 'GET') {
      const session = validateSession(req);
      if (!session) { res.writeHead(401); res.end('Unauthorized'); return; }
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const before = parseInt(url.searchParams.get('before') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
      const db = getChatroomDb();
      const sql = before > 0
        ? `SELECT * FROM (SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
        : `SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
      const rows = before > 0 ? db.prepare(sql).all(before, limit) : db.prepare(sql).all(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        messages: rows.map(r => ({
          id: r.id, authorId: r.author_id, authorName: r.author_name,
          authorType: r.author_type, content: r.content,
          mediaUrl: r.media_url, mediaType: r.media_type, createdAt: r.created_at,
        })),
      }));
      return;
    }

    await handleRequest(req, res);
  } catch (e) {
    console.error('[manager] Request error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!handleChatroomUpgrade(req, socket, head)) {
    socket.destroy();
  }
});

bootstrapUsers();

// Ensure uploads directory exists
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

server.listen(PORT, '0.0.0.0', () => {
  const isWSL = (() => { try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();
  const hostAddr = isWSL
    ? (require('child_process').execSync('hostname -I', { encoding: 'utf8' }).trim().split(/\s+/)[0] || 'localhost')
    : 'localhost';
  console.log(`[manager] ${brand.manager} running on port ${PORT}${BARE_MODE ? ' (bare mode)' : ''}`);
  console.log(`[manager] URL: http://${hostAddr}:${PORT}`);
  console.log(`[manager] Managing ${brand.agents} in: ${ANIMAS_DIR}`);
  console.log(`[manager] Chatroom hub active on /ws/chatroom`);
  console.log(`[manager] Credential vault: ${VAULT_DB_PATH}`);
  console.log(`[manager] Restart mode: marker file (${RESTART_MARKER})`);
});
