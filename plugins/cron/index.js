'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_PERSIST_DIR = '/workspace/.crontabs';
const DEFAULT_LOG_DIR = '/workspace/logs';
const PROACTIVE_URL = 'http://127.0.0.1:${SPORE_WEB_PORT:-18803}/api/proactive/trigger';

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function readFile(file, limit = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const size = stat.size > 0 ? Math.min(stat.size, limit) : limit;
      const buf = Buffer.alloc(size);
      const len = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.slice(0, len).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function execText(command, args = [], opts = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 3000,
    maxBuffer: opts.maxBuffer || 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function currentUser() {
  try {
    return execText('/usr/bin/id', ['-un']).trim() || process.env.USER || 'spore';
  } catch {
    return process.env.USER || 'spore';
  }
}

function commandInfo() {
  return {
    cronWrapper: exists('/usr/local/bin/cron') ? '/usr/local/bin/cron' : null,
    realCron: exists('/usr/sbin/cron') ? '/usr/sbin/cron' : null,
    crontabWrapper: exists('/usr/local/bin/crontab') ? '/usr/local/bin/crontab' : null,
    realCrontab: exists('/usr/bin/crontab') ? '/usr/bin/crontab' : null,
  };
}

function pidfileStatus(file) {
  const raw = readFile(file, 256);
  const pid = raw ? raw.trim() : '';
  if (!pid || !/^\d+$/.test(pid)) return null;
  const cmdline = readFile(`/proc/${pid}/cmdline`, 4096);
  if (!cmdline) return { running: false, pid: Number(pid), source: file };
  return {
    running: cmdline.includes('cron'),
    pid: Number(pid),
    source: file,
    command: cmdline.replace(/\0/g, ' ').trim(),
  };
}

function daemonStatus() {
  const byPid = pidfileStatus('/var/run/crond.pid') || pidfileStatus('/var/run/cron.pid');
  if (byPid) return byPid;
  try {
    const out = execText('/usr/bin/pgrep', ['-x', 'cron']).trim();
    const pid = out.split(/\s+/).filter(Boolean)[0];
    if (pid) return { running: true, pid: Number(pid), source: 'pgrep' };
  } catch {
    // pgrep absent or no match.
  }
  return { running: false, pid: null, source: 'probe' };
}

function listPersistedCrontabs(persistDir) {
  try {
    return fs.readdirSync(persistDir)
      .map(name => {
        const file = path.join(persistDir, name);
        const stat = fs.statSync(file);
        if (!stat.isFile()) return null;
        return {
          user: name,
          path: file,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runtimeTimeInfo() {
  let timezone = process.env.TZ || '';
  try {
    timezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    // Keep the fallback below.
  }
  return {
    now: new Date().toISOString(),
    timezone: timezone || 'container-local',
    note: 'Cron schedules use the container local timezone. Docker defaults to UTC unless TZ is configured.',
  };
}

function readCrontab({ includeLines = false, maxLines = 80 } = {}) {
  const info = commandInfo();
  const user = currentUser();
  const persistDir = process.env.CRONTAB_PERSIST_DIR || DEFAULT_PERSIST_DIR;
  const persistedPath = path.join(persistDir, user);
  const result = {
    user,
    active: { status: 'unavailable', lines: [] },
    persisted: {
      path: persistedPath,
      exists: exists(persistedPath),
      lines: [],
    },
  };

  if (info.realCrontab) {
    try {
      const out = execText(info.realCrontab, ['-l'], { maxBuffer: 256 * 1024 });
      const lines = out.replace(/\s+$/g, '').split(/\r?\n/).filter(line => line.length > 0);
      result.active.status = lines.length ? 'present' : 'empty';
      if (includeLines) result.active.lines = lines.slice(0, maxLines);
      result.active.truncated = lines.length > maxLines;
    } catch (e) {
      const text = String(e.stderr || e.message || '');
      result.active.status = /no crontab/i.test(text) ? 'missing' : 'error';
      if (!/no crontab/i.test(text)) result.active.error = text.trim() || e.message;
    }
  }

  if (result.persisted.exists) {
    const raw = readFile(persistedPath, 256 * 1024) || '';
    const lines = raw.replace(/\s+$/g, '').split(/\r?\n/).filter(line => line.length > 0);
    if (includeLines) result.persisted.lines = lines.slice(0, maxLines);
    result.persisted.truncated = lines.length > maxLines;
  }

  return result;
}

function readActiveCrontabRaw() {
  const info = commandInfo();
  const crontab = info.crontabWrapper || info.realCrontab;
  if (!crontab) throw new Error('crontab command is unavailable.');
  try {
    return execText(crontab, ['-l'], { maxBuffer: 512 * 1024 }).replace(/\s+$/g, '');
  } catch (e) {
    const text = String(e.stderr || e.message || '');
    if (/no crontab/i.test(text)) return '';
    throw e;
  }
}

function writeActiveCrontabRaw(raw) {
  const info = commandInfo();
  const crontab = info.crontabWrapper || info.realCrontab;
  if (!crontab) throw new Error('crontab command is unavailable.');
  const file = path.join('/tmp', `spore-cron-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, String(raw || '').replace(/\s+$/g, '') + '\n', { mode: 0o600 });
  try {
    execText(crontab, [file], { timeout: 5000, maxBuffer: 256 * 1024 });
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

function managedMarkers(name) {
  const clean = sanitizeName(name);
  return {
    name: clean,
    begin: `# SPORE-CRON-BEGIN ${clean}`,
    end: `# SPORE-CRON-END ${clean}`,
  };
}

function removeManagedBlock(raw, name) {
  const markers = managedMarkers(name);
  const lines = String(raw || '').split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === markers.begin) {
      removed++;
      while (i < lines.length && lines[i].trim() !== markers.end) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return { raw: kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/g, ''), removed };
}

function installEntry(input = {}, ctx = {}) {
  const built = input.entry ? null : buildExample(input, ctx);
  const entry = String(input.entry || built?.entry || '').trim();
  if (!entry) return { ok: false, error: 'entry is required unless example fields are supplied.' };
  const name = sanitizeName(input.name || built?.name || 'cron-job');
  const validation = validateEntry({ entry });
  if (!validation.ok) return { ok: false, error: 'Cron entry failed validation.', validation };

  const markers = managedMarkers(name);
  const current = readActiveCrontabRaw();
  const stripped = removeManagedBlock(current, name);
  const existingLines = new Set(stripped.raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const kept = stripped.raw ? stripped.raw.split(/\r?\n/) : [];
  if (!existingLines.has(entry)) {
    if (kept.length && kept[kept.length - 1].trim()) kept.push('');
    kept.push(markers.begin, entry, markers.end);
  }
  const next = kept.join('\n').replace(/\s+$/g, '') + '\n';
  writeActiveCrontabRaw(next);
  return {
    ok: true,
    action: 'install',
    name,
    entry,
    replacedManagedBlock: stripped.removed > 0,
    alreadyPresent: existingLines.has(entry),
    validation,
    crontab: readCrontab({ includeLines: true }),
  };
}

function removeEntry(input = {}) {
  const rawName = String(input.name || '').trim();
  const name = rawName ? sanitizeName(rawName) : '';
  const entry = String(input.entry || '').trim();
  if (!name && !entry) return { ok: false, error: 'name or entry is required for remove.' };
  const current = readActiveCrontabRaw();
  let next = current;
  let removed = 0;
  if (name) {
    const stripped = removeManagedBlock(next, name);
    next = stripped.raw;
    removed += stripped.removed;
  }
  if (entry) {
    const before = next.split(/\r?\n/);
    const after = before.filter(line => line.trim() !== entry);
    removed += before.length - after.length;
    next = after.join('\n').replace(/\s+$/g, '');
  }
  if (removed > 0) writeActiveCrontabRaw(next);
  return {
    ok: true,
    action: 'remove',
    name: name || null,
    removed,
    crontab: readCrontab({ includeLines: true }),
  };
}

function status(input = {}) {
  const persistDir = process.env.CRONTAB_PERSIST_DIR || DEFAULT_PERSIST_DIR;
  const includeCrontab = !!input.includeCrontab || input.action === 'list';
  return {
    ok: true,
    enabledByEnv: String(process.env.SPORE_ENABLE_CRON || 'true').toLowerCase() !== 'false',
    time: runtimeTimeInfo(),
    commands: commandInfo(),
    daemon: daemonStatus(),
    persistDir: {
      path: persistDir,
      exists: exists(persistDir),
      users: listPersistedCrontabs(persistDir),
    },
    crontab: readCrontab({ includeLines: includeCrontab }),
  };
}

function guide() {
  return {
    ok: true,
    cliGated: true,
    summary: 'Use container cron for scheduled triggers. Use startup_tasks for long-running daemons, watchers, and servers.',
    daemon: {
      start: 'cron',
      check: 'cron && crontab -l',
      avoid: [
        '/etc/init.d/cron start',
        'service cron start',
        '/usr/sbin/cron directly',
      ],
      why: 'The container ships /usr/local/bin/cron and /usr/local/bin/crontab wrappers. The wrappers handle already-running cron and crontab persistence.',
    },
    persistence: {
      crontabs: '/workspace/.crontabs/<user>',
      runtimeCrontabs: '/var/spool/cron/crontabs/<user>',
      restoredOnBoot: true,
      disabledBy: 'SPORE_ENABLE_CRON=false',
      note: 'The cron daemon runs as root and correctly reads per-user crontabs. Do not move jobs into root crontab just because the daemon process is root.',
    },
    time: {
      scheduleTimezone: 'container local timezone',
      note: 'Docker defaults to UTC unless TZ is configured. Convert user-facing times before writing cron schedules.',
    },
    workflow: [
      'Call cron { action:"status" } to check daemon and persisted crontabs.',
      'Create cron entries with absolute paths, sparse environment assumptions, and explicit log redirection to an existing directory.',
      'Create the log directory first, for example mkdir -p /workspace/logs; if the redirect target directory is missing, the shell fails before the job command runs.',
      'Call cron { action:"validate", entry:"..." } before installing a new entry.',
      'Install with cron { action:"install", name:"job-name", entry:"..." }. This preserves existing jobs and upserts only that named managed block.',
      'Remove managed jobs with cron { action:"remove", name:"job-name" }. Do not replace the whole crontab from exec unless explicitly preserving every existing line.',
      'Use /api/proactive/trigger when a job needs to notify the operator or start an agent turn.',
    ],
    proactiveTrigger: {
      url: PROACTIVE_URL,
      notify: 'POST JSON {"source":"cron:<name>","message":"...","mode":"notify"} for a cheap operator notification. Add channelId/target like "telegram:<chatId>" to send the exact message to that channel instead of the web panel.',
      agent: 'Use mode:"agent" only when the scheduled event should start a new agent turn. Include channelId/target when it should target a specific channel, such as telegram:<id>. In a Telegram/Discord/Slack conversation, cron action:"example" defaults to the current channel.',
      auth: 'Loopback 127.0.0.1 calls are accepted without auth. External callers need normal web auth.',
    },
    chooseTheRightTool: {
      cron: 'Scheduled jobs, periodic triggers, daily reports, hourly checks.',
      startup_tasks: 'Persistent background processes that should restart after container boot.',
      schedule_wakeup: 'Short follow-up wakeups, roughly minutes rather than permanent schedules.',
    },
  };
}

function sanitizeName(name) {
  const clean = String(name || 'cron-job')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || 'cron-job';
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function hasRedirect(command) {
  return /(^|[^\\])(?:>>?|2>|&>|2>&1|\|\s*(?:tee|logger)\b)/.test(command);
}

function normalizeSchedule(schedule) {
  const raw = String(schedule || '0 9 * * *').trim();
  return raw || '0 9 * * *';
}

function currentChannelTarget(ctx = {}) {
  const raw = String(ctx.channelId || ctx.target || ctx.chatId || '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9_-]*:/i.test(raw)) return raw;
  const platform = String(ctx.platform || '').trim().toLowerCase();
  if (platform && platform !== 'web' && platform !== 'cli') return `${platform}:${raw}`;
  if (platform === 'web') return raw.startsWith('web:') ? raw : `web:${raw}`;
  return raw;
}

function cleanShellToken(token) {
  let value = String(token || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function redirectTargets(command) {
  const targets = [];
  const re = /(?:^|\s)(?:\d?>{1,2}|&>)\s*("[^"]+"|'[^']+'|[^ \t\r\n]+)/g;
  let match;
  while ((match = re.exec(String(command || '')))) {
    const target = cleanShellToken(match[1]);
    if (!target || target.startsWith('&') || target.includes('$') || target.includes('`')) continue;
    targets.push(target);
  }
  return targets;
}

function buildExample(input = {}, ctx = {}) {
  const name = sanitizeName(input.name);
  const schedule = normalizeSchedule(input.schedule);
  const mode = ['notify', 'agent', 'none'].includes(String(input.mode || '').toLowerCase())
    ? String(input.mode || '').toLowerCase()
    : (input.command ? 'none' : 'agent');
  const logPath = input.logPath || `${DEFAULT_LOG_DIR}/cron-${name}.log`;
  let command = String(input.command || '').trim();
  const channelTarget = String(input.channelId || input.target || currentChannelTarget(ctx) || '').trim();

  if (!command) {
    const payload = {
      source: `cron:${name}`,
      message: String(input.message || `Scheduled cron trigger: ${name}`),
      mode: mode === 'none' ? 'notify' : mode,
    };
    if (channelTarget) payload.channelId = channelTarget;
    command = `/usr/bin/curl -fsS -X POST "${PROACTIVE_URL}" -H "content-type: application/json" --data ${shellSingleQuote(JSON.stringify(payload))}`;
  }

  const entry = `${schedule} ${command}${hasRedirect(command) ? '' : ` >>${logPath} 2>&1`}`;
  const installSketch = [];
  if (!hasRedirect(command)) {
    const logDir = path.dirname(String(logPath || ''));
    if (logDir && logDir !== '.' && logDir !== '/') {
      installSketch.push(`mkdir -p ${shellSingleQuote(logDir)}`);
    }
  }
  installSketch.push(
    'tmp="$(mktemp)"',
    'crontab -l 2>/dev/null > "$tmp" || true',
    `printf '%s\\n' ${shellSingleQuote(entry)} >> "$tmp"`,
    'crontab "$tmp"',
    'rm -f "$tmp"',
  );
  return {
    ok: true,
    name,
    entry,
    channelTarget: channelTarget || null,
    installSketch,
    note: 'Run cron { action:"validate", entry:"..." } on the final crontab line before installing it.',
  };
}

function parseCronLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) return null;
  if (trimmed.startsWith('@')) {
    const match = /^(@\S+)\s+(.+)$/.exec(trimmed);
    return match ? { schedule: match[1], command: match[2], raw: trimmed } : { schedule: trimmed, command: '', raw: trimmed };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) return { schedule: parts.slice(0, 5).join(' '), command: '', raw: trimmed, tooShort: true };
  return { schedule: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' '), raw: trimmed };
}

function extractJsonPayload(command) {
  const text = String(command || '');
  const matches = [
    /(?:--data|-d)\s+'([^']*)'/,
    /(?:--data|-d)\s+"([^"]*)"/,
  ];
  for (const re of matches) {
    const m = re.exec(text);
    if (!m) continue;
    try { return JSON.parse(m[1]); } catch {}
  }
  return null;
}

function extractLogPath(command) {
  return redirectTargets(command).find(t => t.startsWith('/')) || null;
}

function scheduleSummary(schedule) {
  const raw = String(schedule || '').trim();
  if (!raw) return '';
  if (raw.startsWith('@')) return raw;
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [min, hour, dom, month, dow] = parts;
  if (raw === '* * * * *') return 'Every minute';
  if (/^\*\/(\d+)$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Hourly at :${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow !== '*') {
    return `${raw} (${hour.padStart(2, '0')}:${min.padStart(2, '0')} on days ${dow})`;
  }
  return raw;
}

function listJobs() {
  const raw = readActiveCrontabRaw();
  const jobs = [];
  let managedName = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const begin = /^#\s*SPORE-CRON-BEGIN\s+(.+)$/.exec(trimmed);
    if (begin) {
      managedName = sanitizeName(begin[1]);
      continue;
    }
    if (/^#\s*SPORE-CRON-END\b/.test(trimmed)) {
      managedName = null;
      continue;
    }
    const parsed = parseCronLine(line);
    if (!parsed || !parsed.command) continue;
    const payload = extractJsonPayload(parsed.command);
    const inferredName = managedName
      || sanitizeName(String(payload?.source || '').replace(/^cron:/, '') || parsed.command.split(/\s+/)[0] || 'cron-job');
    jobs.push({
      name: inferredName,
      managed: !!managedName,
      schedule: parsed.schedule,
      summary: scheduleSummary(parsed.schedule),
      command: parsed.command,
      entry: parsed.raw,
      logPath: extractLogPath(parsed.command),
      proactive: /api\/proactive\/trigger/.test(parsed.command),
      source: payload?.source || null,
      mode: payload?.mode || null,
      message: payload?.message || payload?.text || payload?.context || null,
      channelId: payload?.channelId || payload?.target || payload?.chatId || null,
    });
  }
  return jobs;
}

function commandStartsAbsolute(command) {
  let cmd = String(command || '').trim();
  cmd = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
  const cdMatch = /^cd\s+(\S+)\s+&&\s+(.+)$/.exec(cmd);
  if (cdMatch) cmd = cdMatch[2].trim();
  return cmd.startsWith('/') || cmd.startsWith('(') || cmd.startsWith('{');
}

function validateEntry(input = {}) {
  const entry = String(input.entry || '');
  if (!entry.trim()) return { ok: false, error: 'entry is required for validate.' };

  const warnings = [];
  const lines = entry.split(/\r?\n/);
  let checked = 0;
  for (const [idx, line] of lines.entries()) {
    const parsed = parseCronLine(line);
    if (!parsed) continue;
    checked++;
    const where = `line ${idx + 1}`;
    if (parsed.tooShort || !parsed.command) {
      warnings.push({ severity: 'error', line: idx + 1, message: `${where}: cron entries need a schedule and a command.` });
      continue;
    }
    if (/\/etc\/init\.d\/cron|service\s+cron\s+start|\/usr\/sbin\/cron\b/.test(parsed.command)) {
      warnings.push({ severity: 'error', line: idx + 1, message: `${where}: do not start cron from inside a cron entry; use the runtime wrapper once outside the job.` });
    }
    if (!hasRedirect(parsed.command)) {
      warnings.push({ severity: 'warn', line: idx + 1, message: `${where}: add stdout/stderr redirection so failures are inspectable.` });
    }
    if (!commandStartsAbsolute(parsed.command)) {
      warnings.push({ severity: 'warn', line: idx + 1, message: `${where}: cron has a sparse PATH; prefer an absolute command path or /bin/sh -lc with an absolute script path.` });
    }
    if (/(^|[^\\])%/.test(parsed.command)) {
      warnings.push({ severity: 'warn', line: idx + 1, message: `${where}: unescaped % has special meaning in crontab commands; escape it as \\% if it is literal.` });
    }
    for (const target of redirectTargets(parsed.command)) {
      if (!target.startsWith('/')) continue;
      const parent = path.dirname(target);
      if (parent && parent !== '/' && !exists(parent)) {
        warnings.push({ severity: 'error', line: idx + 1, message: `${where}: redirect target directory does not exist: ${parent}. Create it before installing the crontab or use an existing log path.` });
      }
    }
    if (/api\/proactive\/trigger/.test(parsed.command) && !/127\.0\.0\.1|localhost/.test(parsed.command)) {
      warnings.push({ severity: 'warn', line: idx + 1, message: `${where}: proactive trigger calls are auth-free only on loopback; external URLs need normal web auth.` });
    }
  }

  if (checked === 0) {
    warnings.push({ severity: 'error', line: null, message: 'No cron command lines found. Comments, blanks, and VAR=value lines were ignored.' });
  }

  return {
    ok: !warnings.some(w => w.severity === 'error'),
    checkedLines: checked,
    warnings,
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('request body too large');
  }
  if (!body.trim()) return {};
  return JSON.parse(body);
}

module.exports = function register(api) {
  api.registerWebRoute('GET', '/jobs', (_req, res) => {
    try {
      json(res, 200, {
        ok: true,
        status: status({ includeCrontab: false }),
        jobs: listJobs(),
      });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  api.registerWebRoute('POST', '/jobs', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const result = installEntry(body);
      json(res, result.ok ? 200 : 400, result);
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  api.registerWebRoute('DELETE', '/jobs', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const result = removeEntry(body);
      json(res, result.ok ? 200 : 400, result);
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  api.registerSettingsPane({
    title: 'Cron',
    description: 'Scheduled jobs in this Spore container. Jobs are persisted at /workspace/.crontabs and restored on restart.',
    html: '<div data-plugin-mount="cron">Loading cron jobs...</div>',
  });
  api.registerFrontendAsset('cron-settings.js');

  api.registerTool('cron', {
    namespaced: false,
    available: (ctx = {}) => ctx.platform !== 'cli',
    description: 'Cron runtime guide for scheduled jobs inside this Spore container. Use this before setting up, checking, or troubleshooting cron. It returns wrapper-safe workflow guidance, daemon/crontab status, proactive-trigger examples, and crontab validation. This tool is intentionally hidden from CLI/Spore Code sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['guide', 'status', 'list', 'example', 'validate', 'install', 'remove'],
          description: 'guide returns the cron workflow; status checks daemon and persistence state; list includes current/persisted crontab lines; example builds a safe crontab line; validate checks a crontab entry; install upserts a named managed entry without clobbering other jobs; remove deletes a managed entry.',
        },
        includeCrontab: {
          type: 'boolean',
          description: 'For action=status, include active and persisted crontab lines. action=list always includes them.',
        },
        entry: {
          type: 'string',
          description: 'Crontab line or full crontab text to validate when action=validate. For action=install/remove, this is the exact cron line to add/remove.',
        },
        schedule: {
          type: 'string',
          description: 'Cron schedule for action=example, such as "0 9 * * *" or "@hourly". Default is "0 9 * * *".',
        },
        command: {
          type: 'string',
          description: 'Optional command for action=example. If omitted, the example uses /api/proactive/trigger.',
        },
        name: {
          type: 'string',
          description: 'Short job name for examples, proactive trigger source, and managed install/remove blocks, such as "daily-report".',
        },
        mode: {
          type: 'string',
          enum: ['notify', 'agent', 'none'],
          description: 'For action=example with no command: notify sends a notification, agent starts an agent turn, none is only used with a supplied command.',
        },
        message: {
          type: 'string',
          description: 'Message body for proactive trigger examples.',
        },
        channelId: {
          type: 'string',
          description: 'Optional target for proactive agent examples, such as "telegram:123456" or "web:control-panel". If omitted in a supported channel conversation, the current channel is used.',
        },
        target: {
          type: 'string',
          description: 'Alias for channelId for action=example.',
        },
        logPath: {
          type: 'string',
          description: 'Optional log file path for generated examples. Default: /workspace/logs/cron-<name>.log.',
        },
      },
      required: ['action'],
    },
    execute: async (input = {}, ctx = {}) => {
      if (ctx.platform === 'cli') {
        return { ok: false, error: 'cron is not available in CLI/Spore Code sessions.' };
      }
      const action = String(input.action || 'guide').toLowerCase();
      if (action === 'guide') return guide();
      if (action === 'status' || action === 'list') return status({ ...input, action });
      if (action === 'example') return buildExample(input, ctx);
      if (action === 'validate') return validateEntry(input);
      if (action === 'install') return installEntry(input, ctx);
      if (action === 'remove') return removeEntry(input);
      return { ok: false, error: `Unknown cron action: ${action}` };
    },
  });
};
