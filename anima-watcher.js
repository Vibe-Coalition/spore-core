#!/usr/bin/env node
/**
 * anima-watcher.js
 *
 * Host-side daemon that watches the animas/ directory and handles:
 *   1. Auto-start: new anima dirs (with docker-compose.yml or run.sh) that haven't been started
 *   2. Restart:    .restart marker files written by the manager UI
 *   3. Stop:       .stop marker files written before anima deletion
 *
 * Supports two modes:
 *   - Docker mode (default): uses `docker compose` for lifecycle management
 *   - Bare mode: spawns/kills Node.js processes directly, tracks PIDs
 *
 * Mode is auto-detected per agent: if run.sh exists and docker-compose.yml does not,
 * the agent is managed in bare mode. Set ANIMA_BARE_MODE=true to force bare for all.
 *
 * Usage:
 *   node anima-watcher.js
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const { exec, execSync, spawn } = require('child_process');

const ANIMAS_DIR    = process.env.ANIMAS_DIR || path.join(__dirname, 'animas');
const BASE_DIR      = path.dirname(ANIMAS_DIR.replace(/\/$/, ''));
const POLL_MS       = parseInt(process.env.POLL_MS || '3000', 10);
const STARTED_FILE  = '.watcher-started';
const RESTART_FILE  = '.restart';
const STOP_FILE     = '.stop';
const BUILD_STATUS  = '.build-status.json';
const PID_FILE      = '.pid';
const OLLAMA_CMD    = '.ollama-cmd';
const LOG_PREFIX    = '[anima-watcher]';
const FORCE_BARE    = process.env.ANIMA_BARE_MODE === 'true';

function log(...args)  { console.log(LOG_PREFIX, new Date().toISOString(), ...args); }
function warn(...args) { console.warn(LOG_PREFIX, new Date().toISOString(), 'WARN', ...args); }

// Track child processes spawned in bare mode so we can signal them
const bareChildren = new Map();

function isBareAgent(animaDir) {
  if (FORCE_BARE) return true;
  const hasCompose = fs.existsSync(path.join(animaDir, 'docker-compose.yml'));
  const hasRunSh = fs.existsSync(path.join(animaDir, 'run.sh'));
  return hasRunSh && !hasCompose;
}

function writeBuildStatus(animaDir, status) {
  try {
    fs.writeFileSync(path.join(animaDir, BUILD_STATUS),
      JSON.stringify({ ...status, ts: Date.now() }) + '\n');
  } catch (e) {
    warn(`Failed to write build status: ${e.message}`);
  }
}

function readPid(animaDir) {
  try {
    const raw = fs.readFileSync(path.join(animaDir, PID_FILE), 'utf8').trim();
    return parseInt(raw, 10) || 0;
  } catch { return 0; }
}

function writePid(animaDir, pid) {
  try { fs.writeFileSync(path.join(animaDir, PID_FILE), String(pid) + '\n'); } catch {}
}

function clearPid(animaDir) {
  try { fs.rmSync(path.join(animaDir, PID_FILE), { force: true }); } catch {}
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killProcess(animaId, animaDir) {
  const pid = readPid(animaDir);
  const child = bareChildren.get(animaId);

  if (child && !child.killed) {
    log(`${animaId}: sending SIGTERM to child (pid ${child.pid})`);
    child.kill('SIGTERM');
    bareChildren.delete(animaId);
  } else if (pid && isProcessAlive(pid)) {
    log(`${animaId}: sending SIGTERM to pid ${pid}`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  // Wait briefly for clean shutdown, then force-kill
  setTimeout(() => {
    const p = readPid(animaDir);
    if (p && isProcessAlive(p)) {
      log(`${animaId}: force-killing pid ${p}`);
      try { process.kill(p, 'SIGKILL'); } catch {}
    }
    clearPid(animaDir);
  }, 5000);
}

function parseEnvFile(envPath) {
  const env = {};
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  } catch {}
  return env;
}

function startBareAgent(animaId, animaDir) {
  log(`${animaId}: starting (bare mode)`);
  writeBuildStatus(animaDir, { state: 'starting', cmd: 'bare' });

  const envVars = parseEnvFile(path.join(animaDir, '.env'));
  const srcDir = path.join(BASE_DIR, 'src');
  const indexJs = path.join(srcDir, 'index.js');

  if (!fs.existsSync(indexJs)) {
    warn(`${animaId}: ${indexJs} not found — cannot start`);
    writeBuildStatus(animaDir, { state: 'error', cmd: 'bare', error: 'index.js not found' });
    return;
  }

  const logFile = path.join(animaDir, 'data', 'agent.log');
  let logStream;
  try {
    fs.mkdirSync(path.join(animaDir, 'data'), { recursive: true });
    logStream = fs.openSync(logFile, 'a');
  } catch {
    logStream = 'ignore';
  }

  const child = spawn(process.execPath, [indexJs], {
    cwd: srcDir,
    env: { ...process.env, ...envVars },
    stdio: ['ignore', logStream, logStream],
    detached: true,
  });

  child.unref();
  bareChildren.set(animaId, child);
  writePid(animaDir, child.pid);

  child.on('exit', (code) => {
    log(`${animaId}: process exited (code ${code})`);
    clearPid(animaDir);
    bareChildren.delete(animaId);
    writeBuildStatus(animaDir, { state: code === 0 ? 'stopped' : 'error', cmd: 'bare', exitCode: code });
  });

  log(`${animaId}: started (pid ${child.pid})`);
  writeBuildStatus(animaDir, { state: 'running', cmd: 'bare', pid: child.pid });

  try {
    fs.writeFileSync(path.join(animaDir, STARTED_FILE), new Date().toISOString() + '\n');
  } catch (e) {
    warn(`${animaId}: could not write ${STARTED_FILE}: ${e.message}`);
  }
}

function restartBareAgent(animaId, animaDir) {
  log(`${animaId}: restarting (bare mode)`);
  killProcess(animaId, animaDir);
  setTimeout(() => startBareAgent(animaId, animaDir), 2000);
}

function stopBareAgent(animaId, animaDir, shouldDelete) {
  log(`${animaId}: stopping (bare mode)`);
  killProcess(animaId, animaDir);

  if (shouldDelete) {
    setTimeout(() => {
      log(`${animaId}: deleting directory...`);
      const resolvedDir = path.resolve(animaDir);
      if (!resolvedDir.startsWith(path.resolve(ANIMAS_DIR) + path.sep)) {
        warn(`${animaId}: refusing to delete — path escapes animas directory`);
        return;
      }
      try { fs.rmSync(animaDir, { recursive: true, force: true }); } catch {}
      log(`${animaId}: deleted`);
    }, 6000);
  }
}

function bareNeedsStart(animaDir) {
  return fs.existsSync(path.join(animaDir, 'run.sh'))
      && !fs.existsSync(path.join(animaDir, STARTED_FILE));
}

function bareIsRunning(animaId, animaDir) {
  const child = bareChildren.get(animaId);
  if (child && !child.killed) return true;
  const pid = readPid(animaDir);
  return isProcessAlive(pid);
}

// ── Docker mode functions (unchanged) ────────────────────────────────────────

function ensureBindMountTargets(animaDir) {
  const filesToCheck = ['.env', 'brand.json', 'anima.json'];
  for (const f of filesToCheck) {
    const fp = path.join(animaDir, f);
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
      fs.rmSync(fp, { recursive: true, force: true });
    }
    if (!fs.existsSync(fp)) {
      if (f === 'brand.json' || f === 'anima.json') {
        const baseCopy = path.join(BASE_DIR, f);
        if (fs.existsSync(baseCopy) && fs.statSync(baseCopy).isFile()) {
          try { fs.copyFileSync(baseCopy, fp); } catch { fs.writeFileSync(fp, '{}'); }
        } else {
          fs.writeFileSync(fp, '{}');
        }
      } else {
        fs.writeFileSync(fp, '');
      }
    }
  }
  for (const d of ['data', 'workspace', 'static', 'src']) {
    const dp = path.join(animaDir, d);
    if (fs.existsSync(dp) && !fs.statSync(dp).isDirectory()) fs.rmSync(dp);
    if (!fs.existsSync(dp)) fs.mkdirSync(dp, { recursive: true });
  }
  const gv = path.join(animaDir, 'static', 'graph-viewer.html');
  if (!fs.existsSync(gv)) {
    const src = path.join(BASE_DIR, 'src', 'static', 'graph-viewer.html');
    if (fs.existsSync(src)) try { fs.copyFileSync(src, gv); } catch {}
  }
  const bjs = path.join(animaDir, 'static', 'brand.js');
  if (!fs.existsSync(bjs)) {
    const src = path.join(BASE_DIR, 'src', 'static', 'brand.js');
    if (fs.existsSync(src)) try { fs.copyFileSync(src, bjs); } catch {}
  }
}

function dockerCompose(animaId, animaDir, cmd) {
  log(`${animaId}: running "docker compose ${cmd}"`);
  ensureBindMountTargets(animaDir);
  writeBuildStatus(animaDir, { state: 'building', cmd });

  exec(`docker compose ${cmd} 2>&1`, {
    cwd: animaDir,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  }, (err, stdout) => {
    const output = (stdout || '').toString().trim();
    const lastLines = output.split('\n').slice(-10).join('\n');
    if (err) {
      warn(`${animaId}: ${err.message}`);
      writeBuildStatus(animaDir, { state: 'error', cmd, error: err.message, output: lastLines });
    } else {
      log(`${animaId}: done — ${output.split('\n').pop()}`);
      writeBuildStatus(animaDir, { state: 'running', cmd, output: lastLines });
    }
  });
}

function dockerNeedsStart(animaDir) {
  return fs.existsSync(path.join(animaDir, 'docker-compose.yml'))
      && !fs.existsSync(path.join(animaDir, STARTED_FILE));
}

function startDockerAnima(animaId, animaDir) {
  log(`${animaId}: first start (build + up)`);
  ensureBindMountTargets(animaDir);
  writeBuildStatus(animaDir, { state: 'building', cmd: 'up -d --build' });

  try {
    const out = execSync('docker compose up -d --build 2>&1', {
      cwd: animaDir, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
    });
    const output = out.toString().trim();
    const lastLines = output.split('\n').slice(-10).join('\n');
    log(`${animaId}: started — ${output.split('\n').pop()}`);
    writeBuildStatus(animaDir, { state: 'running', cmd: 'up -d --build', output: lastLines });
    try {
      fs.writeFileSync(path.join(animaDir, STARTED_FILE), new Date().toISOString() + '\n');
    } catch (e) {
      warn(`${animaId}: could not write ${STARTED_FILE}: ${e.message}`);
    }
  } catch (e) {
    const errOutput = (e.stdout || e.stderr || e.message || '').toString().trim();
    const lastLines = errOutput.split('\n').slice(-15).join('\n');
    warn(`${animaId}: start failed — ${lastLines.split('\n').pop()}`);
    writeBuildStatus(animaDir, { state: 'error', cmd: 'up -d --build', error: lastLines });
  }
}

// ── Ollama helpers ───────────────────────────────────────────────────────────

function updateOllamaStatus() {
  const statusPath = path.join(ANIMAS_DIR, '.ollama-status.json');
  const http = require('http');

  const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 3000 }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        const models = (data.models || []).map(m => ({
          name: m.name, size: m.size, modified: m.modified_at,
        }));
        fs.writeFileSync(statusPath, JSON.stringify({ running: true, models, ts: Date.now() }));
      } catch {
        fs.writeFileSync(statusPath, JSON.stringify({ running: true, models: [], ts: Date.now() }));
      }
    });
  });
  req.on('error', () => {
    fs.writeFileSync(statusPath, JSON.stringify({ running: false, models: [], ts: Date.now() }));
  });
  req.end();
}

function handleOllamaCmd() {
  const cmdPath = path.join(ANIMAS_DIR, OLLAMA_CMD);
  if (!fs.existsSync(cmdPath)) return;

  let cmd;
  try {
    cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
  } catch { return; }
  try { fs.rmSync(cmdPath, { force: true }); } catch {}

  const resultPath = path.join(ANIMAS_DIR, '.ollama-result');

  if (cmd.action === 'pull') {
    const model = (cmd.model || '').replace(/[^a-zA-Z0-9._:/-]/g, '');
    if (!model || model.length > 200) return;
    log(`ollama: pulling ${model}...`);
    fs.writeFileSync(resultPath, JSON.stringify({ action: 'pull', model, status: 'pulling', ts: Date.now() }));
    exec(`ollama pull "${model}" 2>&1`, {
      timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      const ok = !err;
      const output = (stdout || '').trim().split('\n').slice(-3).join('\n');
      log(`ollama: pull ${model} ${ok ? 'succeeded' : 'failed'} — ${output}`);
      fs.writeFileSync(resultPath, JSON.stringify({ action: 'pull', model, ok, output, ts: Date.now() }));
      updateOllamaStatus();
    });
  }
}

// ── Main scan loop ───────────────────────────────────────────────────────────

function scan() {
  try { handleOllamaCmd(); } catch (e) { warn(`ollama handler error: ${e.message}`); }

  let entries;
  try {
    entries = fs.readdirSync(ANIMAS_DIR, { withFileTypes: true });
  } catch (e) {
    warn(`Cannot read ${ANIMAS_DIR}: ${e.message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const animaDir = path.join(ANIMAS_DIR, entry.name);
    const animaId = entry.name;
    const bare = isBareAgent(animaDir);

    try {
      // Skip if explicitly stopped
      if (fs.existsSync(path.join(animaDir, '.stopped'))) {
        const restartPath = path.join(animaDir, RESTART_FILE);
        if (fs.existsSync(restartPath)) {
          let mode = 'restart';
          try {
            const content = fs.readFileSync(restartPath, 'utf8');
            const parsed = JSON.parse(content);
            if (parsed.mode === 'rebuild') mode = 'rebuild';
          } catch {}
          try { fs.rmSync(restartPath, { force: true }); } catch {}

          if (bare) {
            startBareAgent(animaId, animaDir);
          } else if (mode === 'rebuild') {
            dockerCompose(animaId, animaDir, 'up -d --build');
          } else {
            dockerCompose(animaId, animaDir, 'up -d --force-recreate');
          }
        }
        const stopPath = path.join(animaDir, STOP_FILE);
        if (fs.existsSync(stopPath)) {
          try { fs.rmSync(stopPath, { force: true }); } catch {}
        }
        continue;
      }

      // Handle .restart marker
      const restartPath = path.join(animaDir, RESTART_FILE);
      if (fs.existsSync(restartPath)) {
        let mode = 'restart';
        try {
          const content = fs.readFileSync(restartPath, 'utf8');
          const parsed = JSON.parse(content);
          if (parsed.mode === 'rebuild') mode = 'rebuild';
          if (parsed.mode === 'recreate') mode = 'recreate';
        } catch {}
        try { fs.rmSync(restartPath, { force: true }); } catch {}

        if (bare) {
          restartBareAgent(animaId, animaDir);
        } else if (mode === 'rebuild') {
          dockerCompose(animaId, animaDir, 'up -d --build');
        } else if (mode === 'recreate') {
          dockerCompose(animaId, animaDir, 'up -d --force-recreate');
        } else {
          dockerCompose(animaId, animaDir, 'restart');
        }
        continue;
      }

      // Handle .stop marker
      const stopPath = path.join(animaDir, STOP_FILE);
      if (fs.existsSync(stopPath)) {
        let shouldDelete = false;
        try {
          const content = fs.readFileSync(stopPath, 'utf8');
          const parsed = JSON.parse(content);
          shouldDelete = parsed.delete === true;
        } catch {}
        try { fs.rmSync(stopPath, { force: true }); } catch {}

        if (bare) {
          stopBareAgent(animaId, animaDir, shouldDelete);
        } else {
          try {
            execSync('docker compose down 2>&1', { cwd: animaDir, timeout: 60_000 });
            log(`${animaId}: stopped`);
          } catch (e) {
            warn(`${animaId}: stop failed — ${(e.message || '').split('\n').pop()}`);
          }

          if (shouldDelete) {
            log(`${animaId}: deleting directory...`);
            try {
              const resolvedDir = path.resolve(animaDir);
              if (!resolvedDir.startsWith(path.resolve(ANIMAS_DIR) + path.sep)) {
                warn(`${animaId}: refusing to delete — path escapes animas directory`);
              } else {
                execSync(`docker run --rm -v ${JSON.stringify(resolvedDir + ':/target')} alpine rm -rf /target 2>&1`, { timeout: 30_000 });
              }
            } catch {}
            try { fs.rmSync(animaDir, { recursive: true, force: true }); } catch {}
            log(`${animaId}: deleted`);
          }
        }
        continue;
      }

      // Auto-start new agents
      if (bare) {
        if (bareNeedsStart(animaDir) && !bareIsRunning(animaId, animaDir)) {
          startBareAgent(animaId, animaDir);
        }
      } else {
        if (dockerNeedsStart(animaDir)) {
          startDockerAnima(animaId, animaDir);
        }
      }
    } catch (e) {
      warn(`${animaId}: scan error — ${e.message}`);
    }
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  log('Shutting down — stopping bare agents...');
  for (const [animaId, child] of bareChildren) {
    if (!child.killed) {
      log(`${animaId}: sending SIGTERM`);
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ────────────────────────────────────────────────────────────────────

log(`Watching ${ANIMAS_DIR} (poll ${POLL_MS}ms)${FORCE_BARE ? ' [bare mode forced]' : ''}`);

updateOllamaStatus();
setInterval(updateOllamaStatus, 15000);

try {
  fs.watch(ANIMAS_DIR, { persistent: true }, (event, filename) => {
    if (!filename || filename.startsWith('.')) return;
    scan();
  });
  log('inotify active');
} catch (e) {
  warn(`fs.watch failed (${e.message}), poll only`);
}

setInterval(scan, POLL_MS);
scan();
