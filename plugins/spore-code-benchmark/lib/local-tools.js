'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { evaluateCommandResult } = require('./verification');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.venv',
  'venv',
  'target',
  '.next',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 80000;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const HEAVY_PYTHON_PACKAGES = [
  'torch',
  'torchvision',
  'torchaudio',
  'tensorflow',
  'tensorflow-cpu',
  'jax',
  'jaxlib',
  'transformers',
  'sentence-transformers',
  'triton',
];

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isSubpath(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function stableError(message) {
  return { error: String(message || 'unknown error') };
}

function globToRegex(pattern) {
  const p = toPosix(pattern || '*');
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\.^$+{}()|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function commandLooksDangerous(command) {
  const s = String(command || '');
  const compact = s.replace(/\s+/g, ' ');
  const pipInstall = /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b/i.test(compact);
  const pipLooksLocal = /(?:--user(?:\s|$)|--target(?:=|\s)|(?:^|\s)-t\s+|VIRTUAL_ENV=|(?:^|\s)(?:source|\.)\s+[^;&|]+\/bin\/activate\b|\$SPORE_BENCHMARK_CACHE|SPORE_BENCHMARK_CACHE=|\/\.venv\/|\/venv\/|\/bin\/python(?:3)?\s+-m\s+pip\s+install\b)/i.test(compact);
  const checks = [
    /\brm\s+(-[A-Za-z]*r[A-Za-z]*f|-rf|-fr)\s+\/(?:\s|$)/,
    /\bmkfs(?:\.[a-z0-9]+)?\b/i,
    /\bdd\s+if=.*\sof=\/dev\//i,
    /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
    /\bsudo\b/,
    /\b(?:apt-get|apt|dpkg|apk|yum|dnf|pacman|zypper|brew)\s+(?:install|remove|purge|upgrade|dist-upgrade|add|del|erase|update|autoremove)\b/i,
    /\bnpm\s+(?:install|i|add)\b[^;&|]*(?:^|\s)-g(?:\s|$)/i,
    /\b(?:pnpm|yarn)\s+(?:add|global)\b[^;&|]*(?:^|\s)-g(?:\s|$)/i,
    /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b[^;&|]*--break-system-packages\b/i,
    /\b(chown|chmod)\s+.*\s\/(?:\s|$)/,
    /\bdocker\s+(?:system\s+prune|rm|rmi|volume\s+rm|network\s+rm)\b/i,
    /\bpodman\s+(?:system\s+prune|rm|rmi|volume\s+rm|network\s+rm)\b/i,
  ];
  return checks.some(re => re.test(s)) || (pipInstall && !pipLooksLocal);
}

function commandResourceViolation(command) {
  const s = String(command || '');
  const compact = s.replace(/\s+/g, ' ');
  if (/\bSPORE_BENCHMARK_ALLOW_HEAVY_DEPS\s*=\s*1\b/.test(compact)) return null;
  const pipInstall = /\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b/i.test(compact);
  if (!pipInstall) return null;
  for (const pkg of HEAVY_PYTHON_PACKAGES) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s"'=])${escaped}(?:\\[[^\\]]*\\])?(?:[<>=!~ ,;&|]|$)`, 'i');
    if (re.test(compact)) {
      return `Command installs heavyweight Python package "${pkg}". Use lightweight/static checks, preinstalled packages, or set SPORE_BENCHMARK_ALLOW_HEAVY_DEPS=1 for an explicit heavyweight scenario.`;
    }
  }
  if (/\bnvidia[-_][a-z0-9_.-]+/i.test(compact)) {
    return 'Command installs NVIDIA/CUDA Python packages. Benchmark smoke tasks should not pull GPU stacks unless explicitly allowed with SPORE_BENCHMARK_ALLOW_HEAVY_DEPS=1.';
  }
  return null;
}

function benchmarkRunRoot(absPath) {
  const p = toPosix(path.resolve(String(absPath || '')));
  const marker = '/runs/';
  const idx = p.indexOf(marker);
  if (idx < 0) return null;
  const rest = p.slice(idx + marker.length);
  const runId = rest.split('/')[0];
  return runId ? p.slice(0, idx + marker.length + runId.length) : null;
}

function commandIsolationViolation(command, currentRunRoot = null) {
  const s = String(command || '');
  const compact = s.replace(/\s+/g, ' ');
  if (/\bfind\s+\/(?:\s|$)/.test(compact)) {
    return 'Command searches the host root filesystem; benchmark exec is limited to the repo and current run cache';
  }
  if (/\bfind\s+\/data\/spore-code-benchmark(?:\/|\s|$)/.test(compact)) {
    return 'Command searches all benchmark runs; use the current repo or $SPORE_BENCHMARK_CACHE only';
  }
  const paths = s.match(/\/[A-Za-z0-9._~:+@%=-][^\s"'`$;&|<>)]*/g) || [];
  const current = currentRunRoot ? toPosix(currentRunRoot) : null;
  for (const raw of paths) {
    const runRoot = benchmarkRunRoot(raw);
    if (runRoot && current && runRoot !== current) {
      return `Command references another benchmark run: ${raw}`;
    }
  }
  return null;
}

function compactOutput(text, maxBytes) {
  const s = String(text || '');
  const buf = Buffer.from(s);
  if (buf.length <= maxBytes) return s;
  const head = buf.subarray(0, Math.floor(maxBytes * 0.65)).toString();
  const tail = buf.subarray(buf.length - Math.floor(maxBytes * 0.30)).toString();
  return `${head}\n\n[... output truncated to ${maxBytes} bytes ...]\n\n${tail}`;
}

class LocalToolExecutor {
  constructor(opts = {}) {
    if (!opts.root) throw new Error('LocalToolExecutor requires root');
    this.root = path.resolve(opts.root);
    this.envHome = path.resolve(opts.envHome || this.root);
    this.extraEnv = { ...(opts.extraEnv || {}) };
    this.runRoot = benchmarkRunRoot(this.root) || benchmarkRunRoot(this.envHome);
    this.maxOutputBytes = Math.max(2000, Number(opts.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES);
    this.maxReadBytes = Math.max(4000, Number(opts.maxReadBytes) || DEFAULT_MAX_READ_BYTES);
    this.defaultTimeoutMs = Math.max(1000, Number(opts.defaultTimeoutMs) || DEFAULT_TIMEOUT_MS);
    this.log = opts.log || null;
    fs.mkdirSync(this.envHome, { recursive: true });
  }

  resolvePath(inputPath, opts = {}) {
    const raw = String(inputPath || this.root).trim() || this.root;
    const base = opts.base ? this.resolvePath(opts.base, { mustExist: true, directory: true }) : this.root;
    const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw));
    if (!isSubpath(this.root, abs)) {
      throw new Error(`Path escapes benchmark workspace: ${raw}`);
    }
    if (opts.mustExist && !fs.existsSync(abs)) {
      throw new Error(`Path does not exist: ${raw}`);
    }
    if (opts.directory) {
      if (opts.mustExist && !fs.statSync(abs).isDirectory()) {
        throw new Error(`Path is not a directory: ${raw}`);
      }
    }
    if (opts.forWrite) {
      const parent = path.dirname(abs);
      if (!isSubpath(this.root, parent)) {
        throw new Error(`Path escapes benchmark workspace: ${raw}`);
      }
    }
    return abs;
  }

  relative(absPath) {
    return toPosix(path.relative(this.root, absPath)) || '.';
  }

  async execute(name, input = {}) {
    try {
      switch (String(name || '')) {
        case 'list_dir': return this.listDir(input);
        case 'read_file': return this.readFile(input);
        case 'read_many_files': return this.readManyFiles(input);
        case 'write_file': return this.writeFile(input);
        case 'edit_file': return this.editFile(input);
        case 'grep': return this.grep(input);
        case 'glob': return this.glob(input);
        case 'git_status': return this.gitStatus(input);
        case 'git_diff': return this.gitDiff(input);
        case 'git_untracked_summary': return this.gitUntrackedSummary(input);
        case 'patch_file': return this.patchFile(input);
        case 'run_tests': return this.runTests(input);
        case 'exec': return this.exec(input);
        default: return stableError(`Unsupported benchmark local tool: ${name}`);
      }
    } catch (e) {
      return stableError(e.message);
    }
  }

  listDir(input = {}) {
    const dir = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    const includeHidden = !!input.include_hidden;
    const max = Math.min(1000, Math.max(1, Math.floor(Number(input.max_entries) || 200)));
    const names = fs.readdirSync(dir).filter(name => includeHidden || !name.startsWith('.')).slice(0, max);
    const entries = names.map(name => {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      return {
        name,
        path: abs,
        relative: this.relative(abs),
        type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    });
    return { path: dir, relative: this.relative(dir), entries, truncated: names.length >= max };
  }

  readFile(input = {}) {
    const file = this.resolvePath(input.path, { mustExist: true });
    const st = fs.statSync(file);
    if (!st.isFile()) return stableError(`Not a file: ${input.path}`);
    if (st.size > this.maxReadBytes) {
      return stableError(`File too large for read_file (${st.size} bytes > ${this.maxReadBytes})`);
    }
    const raw = fs.readFileSync(file);
    if (raw.includes(0)) return stableError(`File appears to be binary: ${input.path}`);
    const lines = raw.toString('utf8').split(/\r?\n/);
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const limit = input.limit == null ? lines.length : Math.max(1, Math.floor(Number(input.limit) || lines.length));
    const selected = lines.slice(offset, offset + limit);
    return {
      path: file,
      relative: this.relative(file),
      offset,
      lines: selected.length,
      totalLines: lines.length,
      content: selected.join('\n'),
    };
  }

  readManyFiles(input = {}) {
    const paths = Array.isArray(input.paths) ? input.paths.slice(0, 20) : [];
    return {
      files: paths.map(p => this.readFile({ path: p, offset: input.offset, limit: input.limit })),
    };
  }

  writeFile(input = {}) {
    const file = this.resolvePath(input.path, { forWrite: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = String(input.content ?? '');
    if (input.append) fs.appendFileSync(file, content);
    else fs.writeFileSync(file, content);
    return { ok: true, path: file, relative: this.relative(file), bytes: Buffer.byteLength(content) };
  }

  editFile(input = {}) {
    const file = this.resolvePath(input.path, { mustExist: true });
    const oldText = String(input.old_text ?? '');
    const newText = String(input.new_text ?? '');
    if (!oldText) return stableError('old_text is required');
    const before = fs.readFileSync(file, 'utf8');
    const count = before.split(oldText).length - 1;
    if (count <= 0) return stableError('old_text not found');
    if (!input.all && count > 1) {
      return stableError(`old_text is not unique (${count} matches); pass all:true or add more context`);
    }
    const after = input.all ? before.split(oldText).join(newText) : before.replace(oldText, newText);
    fs.writeFileSync(file, after);
    return { ok: true, path: file, relative: this.relative(file), replacements: input.all ? count : 1 };
  }

  walkFiles(startDir, opts = {}) {
    const maxFiles = Math.max(100, Math.floor(Number(opts.maxFiles) || 10000));
    const out = [];
    const stack = [startDir];
    while (stack.length && out.length < maxFiles) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (!isSubpath(this.root, abs)) continue;
        if (entry.isDirectory()) stack.push(abs);
        else if (entry.isFile()) out.push(abs);
        if (out.length >= maxFiles) break;
      }
    }
    return out;
  }

  glob(input = {}) {
    const dir = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    const pattern = String(input.pattern || '*');
    const matchRel = pattern.includes('/');
    const re = globToRegex(pattern);
    const files = this.walkFiles(dir, { maxFiles: 20000 })
      .filter(abs => re.test(matchRel ? toPosix(path.relative(dir, abs)) : path.basename(abs)))
      .slice(0, 500)
      .map(abs => ({ path: abs, relative: this.relative(abs) }));
    return { pattern, path: dir, files, truncated: files.length >= 500 };
  }

  grep(input = {}) {
    const dir = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    const flags = input['-i'] ? 'i' : '';
    let re;
    try { re = new RegExp(String(input.pattern || ''), flags); } catch (e) { return stableError(`Invalid regex: ${e.message}`); }
    const globRe = input.glob ? globToRegex(input.glob) : null;
    const matches = [];
    for (const file of this.walkFiles(dir, { maxFiles: 20000 })) {
      if (globRe && !globRe.test(path.basename(file)) && !globRe.test(toPosix(path.relative(dir, file)))) continue;
      let raw;
      try {
        const st = fs.statSync(file);
        if (st.size > this.maxReadBytes) continue;
        raw = fs.readFileSync(file);
      } catch { continue; }
      if (raw.includes(0)) continue;
      const lines = raw.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matches.push({
          file,
          relative: this.relative(file),
          line: i + 1,
          text: lines[i].slice(0, 240),
        });
        if (matches.length >= 200) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }

  gitStatus(input = {}) {
    const cwd = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return Promise.resolve({ ok: false, command: 'git status --short --branch', cwd, stdout: '', stderr: 'not a prepared git worktree', skipped: true });
    }
    return this.exec({ command: 'git status --short --branch', workdir: cwd, timeout: 15000 });
  }

  gitDiff(input = {}) {
    const cwd = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return Promise.resolve({ ok: false, command: 'git diff', cwd, stdout: '', stderr: 'not a prepared git worktree', skipped: true });
    }
    const parts = ['git diff'];
    if (input.staged) parts.push('--staged');
    if (input.stat) parts.push('--stat');
    if (input.ref) parts.push(String(input.ref));
    if (input.file) {
      const file = this.resolvePath(input.file, { base: cwd });
      parts.push('--', JSON.stringify(this.relative(file)));
    }
    const limit = Math.min(200000, Math.max(2000, Math.floor(Number(input.limit) || 20000)));
    return this.exec({ command: parts.join(' '), workdir: cwd, timeout: 30000, maxOutputBytes: limit });
  }

  async gitUntrackedSummary(input = {}) {
    const cwd = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return { ok: false, count: 0, files: [], totalBytes: 0, totalLines: 0, statText: '', stderr: 'not a prepared git worktree', skipped: true };
    }
    const maxFiles = Math.min(200, Math.max(1, Math.floor(Number(input.maxFiles) || 80)));
    const listed = await this.exec({
      command: 'git ls-files --others --exclude-standard -z',
      workdir: cwd,
      timeout: 15000,
      maxOutputBytes: 200000,
    });
    if (!listed.ok) return listed;
    const paths = String(listed.stdout || '')
      .split('\0')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, maxFiles);
    let totalBytes = 0;
    let totalLines = 0;
    const files = [];
    for (const rel of paths) {
      let abs;
      try {
        abs = this.resolvePath(rel, { base: cwd, mustExist: true });
      } catch {
        continue;
      }
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      totalBytes += st.size;
      let lines = null;
      let binary = false;
      try {
        const raw = fs.readFileSync(abs);
        binary = raw.includes(0);
        if (!binary) {
          const text = raw.toString('utf8');
          lines = text.length ? text.split(/\r?\n/).length : 0;
          totalLines += lines;
        }
      } catch {
        binary = true;
      }
      files.push({
        path: rel.replace(/\\/g, '/'),
        bytes: st.size,
        lines,
        binary,
      });
    }
    return {
      ok: true,
      count: files.length,
      truncated: paths.length >= maxFiles,
      totalBytes,
      totalLines,
      files,
      statText: files.length
        ? `${files.length} untracked file${files.length === 1 ? '' : 's'}, ${totalLines} insertion${totalLines === 1 ? '' : 's'}(+)`
        : '',
    };
  }

  async patchFile(input = {}) {
    const cwd = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    const patch = String(input.patch || '');
    if (!patch.trim()) return stableError('patch is required');
    const result = await this._runCommand('git apply --check --whitespace=nowarn -', {
      cwd,
      timeoutMs: 30000,
      stdin: patch,
    });
    if (result.exitCode !== 0) return result;
    if (input.dry_run) return { ...result, ok: true, dryRun: true };
    return this._runCommand('git apply --whitespace=nowarn -', { cwd, timeoutMs: 30000, stdin: patch });
  }

  detectTestCommand(cwd) {
    if (fs.existsSync(path.join(cwd, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) return 'npm test';
      } catch {}
    }
    if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
    if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'pytest.ini'))) return 'python -m pytest';
    return null;
  }

  runTests(input = {}) {
    const cwd = this.resolvePath(input.path || this.root, { mustExist: true, directory: true });
    const command = String(input.command || this.detectTestCommand(cwd) || '').trim();
    if (!command) return stableError('Could not detect a test command');
    const timeout = Math.min(600000, Math.max(1000, Math.floor(Number(input.timeout) || 120000)));
    return this.exec({ command, workdir: cwd, timeout });
  }

  exec(input = {}) {
    const command = String(input.command || '').trim();
    if (!command) return Promise.resolve(stableError('command is required'));
    if (commandLooksDangerous(command)) return Promise.resolve(stableError('Command blocked by benchmark sandbox policy'));
    const resourceViolation = commandResourceViolation(command);
    if (resourceViolation) return Promise.resolve(stableError(resourceViolation));
    const isolationViolation = commandIsolationViolation(command, this.runRoot);
    if (isolationViolation) return Promise.resolve(stableError(isolationViolation));
    const cwd = this.resolvePath(input.workdir || this.root, { mustExist: true, directory: true });
    const timeout = Math.min(600000, Math.max(1000, Math.floor(Number(input.timeout) || this.defaultTimeoutMs)));
    const maxOutputBytes = Math.min(400000, Math.max(1000, Math.floor(Number(input.maxOutputBytes) || this.maxOutputBytes)));
    return this._runCommand(command, { cwd, timeoutMs: timeout, maxOutputBytes });
  }

  _runCommand(command, opts = {}) {
    const cwd = opts.cwd || this.root;
    const maxOutputBytes = opts.maxOutputBytes || this.maxOutputBytes;
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;
    return new Promise((resolve) => {
      const started = Date.now();
      const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
      const cacheRoot = this.extraEnv.SPORE_BENCHMARK_CACHE || path.join(this.envHome, '.cache', 'spore-code-benchmark');
      const cacheBin = path.join(cacheRoot, 'bin');
      const goBin = path.join(cacheRoot, 'toolchains', 'go', 'bin');
      const cargoBin = path.join(cacheRoot, 'cargo', 'bin');
      const localBin = path.join(this.envHome, '.local', 'bin');
      const env = {
        PATH: `${cacheBin}:${goBin}:${cargoBin}:${localBin}:${basePath}`,
        HOME: this.envHome,
        CI: '1',
        TERM: 'dumb',
        LANG: process.env.LANG || 'C.UTF-8',
        XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
        npm_config_cache: path.join(cacheRoot, 'npm'),
        PIP_CACHE_DIR: path.join(cacheRoot, 'pip'),
        UV_CACHE_DIR: path.join(cacheRoot, 'uv'),
        GOCACHE: path.join(cacheRoot, 'go-build'),
        GOMODCACHE: path.join(cacheRoot, 'go-mod'),
        GOPATH: path.join(cacheRoot, 'go'),
        GOBIN: cacheBin,
        CARGO_HOME: path.join(cacheRoot, 'cargo'),
        RUSTUP_HOME: path.join(cacheRoot, 'rustup'),
        PYTHONUSERBASE: path.join(this.envHome, '.local'),
        SPORE_BENCHMARK_CACHE: cacheRoot,
        ...this.extraEnv,
      };
      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.mkdirSync(cacheBin, { recursive: true });
      const child = spawn('/bin/bash', ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
      }, timeoutMs);
      if (opts.stdin) {
        child.stdin.end(opts.stdin);
      } else {
        child.stdin.end();
      }
      child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > maxOutputBytes * 2) stdout = stdout.slice(-maxOutputBytes); });
      child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > maxOutputBytes * 2) stderr = stderr.slice(-maxOutputBytes); });
      child.on('error', e => {
        clearTimeout(timer);
        resolve(stableError(e.message));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const result = {
          ok: code === 0 && !timedOut,
          command,
          cwd,
          exitCode: code,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdout: compactOutput(stdout, maxOutputBytes),
          stderr: compactOutput(stderr, maxOutputBytes),
        };
        resolve(evaluateCommandResult(command, result));
      });
    });
  }
}

module.exports = {
  LocalToolExecutor,
  _test: {
    benchmarkRunRoot,
    commandLooksDangerous,
    commandResourceViolation,
    commandIsolationViolation,
    globToRegex,
    isSubpath,
  },
};
