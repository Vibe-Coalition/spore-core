'use strict';

const https = require('https');
const http = require('http');

const POPULAR_NPM = new Set([
  'express', 'react', 'react-dom', 'next', 'vue', 'angular', 'lodash', 'axios',
  'typescript', 'webpack', 'babel', 'eslint', 'prettier', 'jest', 'mocha', 'chai',
  'mongoose', 'sequelize', 'prisma', 'pg', 'mysql2', 'redis', 'socket.io',
  'cors', 'dotenv', 'uuid', 'moment', 'dayjs', 'chalk', 'commander', 'yargs',
  'fs-extra', 'glob', 'rimraf', 'mkdirp', 'debug', 'winston', 'pino',
  'sharp', 'jimp', 'puppeteer', 'playwright', 'cheerio', 'jsdom',
  'tailwindcss', 'postcss', 'sass', 'styled-components', 'emotion',
  'three', 'd3', 'chart.js', 'echarts', 'p5',
  'fastify', 'koa', 'hapi', 'nest', 'nuxt', 'svelte', 'solid-js',
  'zod', 'joi', 'yup', 'ajv', 'jsonwebtoken', 'bcrypt', 'passport',
  'nodemailer', 'bull', 'agenda', 'cron', 'node-cron',
  'openai', 'langchain', 'anthropic', '@anthropic-ai/sdk',
  'discord.js', 'telegraf', 'grammy', 'slack-bolt',
  'litellm', 'llama-index', 'transformers',
]);

const POPULAR_PIP = new Set([
  'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'plotly',
  'requests', 'httpx', 'aiohttp', 'flask', 'django', 'fastapi', 'uvicorn',
  'sqlalchemy', 'alembic', 'psycopg2', 'pymongo', 'redis', 'celery',
  'pytest', 'unittest', 'coverage', 'tox', 'black', 'ruff', 'mypy', 'pylint',
  'pillow', 'opencv-python', 'scikit-learn', 'tensorflow', 'torch', 'pytorch',
  'transformers', 'huggingface-hub', 'tokenizers', 'datasets',
  'openai', 'anthropic', 'langchain', 'litellm', 'llamaindex',
  'boto3', 'google-cloud-storage', 'azure-storage-blob',
  'pydantic', 'typer', 'click', 'rich', 'tqdm', 'loguru',
  'beautifulsoup4', 'scrapy', 'selenium', 'playwright',
  'cryptography', 'paramiko', 'fabric', 'docker',
  'streamlit', 'gradio', 'dash', 'panel',
  'networkx', 'igraph', 'pygraphviz',
]);

const RISK_LEVEL = {
  BLOCK: 'block',
  WARN: 'warn',
  OK: 'ok',
};

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function checkTyposquat(name, popularSet) {
  const normalized = name.toLowerCase().replace(/[_.-]/g, '');
  for (const popular of popularSet) {
    const popNorm = popular.toLowerCase().replace(/[_.-]/g, '');
    if (normalized === popNorm) continue; // exact match after normalization = fine
    const dist = levenshtein(normalized, popNorm);
    if (dist === 1 && normalized !== popNorm) {
      return { suspect: true, similar_to: popular, distance: dist };
    }
    // Common typosquat patterns: prepend/append common words
    if (normalized !== popNorm && (
      normalized === popNorm + 's' ||
      normalized === popNorm + 'js' ||
      normalized === popNorm + 'py' ||
      normalized === 'python' + popNorm ||
      normalized === 'node' + popNorm ||
      normalized === popNorm + 'lib' ||
      normalized === popNorm + '2' ||
      normalized.replace(/[0o]/g, '0') === popNorm.replace(/[0o]/g, '0') // o/0 swap
    )) {
      return { suspect: true, similar_to: popular, distance: dist, pattern: 'naming_trick' };
    }
  }
  return { suspect: false };
}

function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function vetNpmPackage(name, version) {
  const findings = [];
  let riskLevel = RISK_LEVEL.OK;

  try {
    const url = version && version !== 'latest'
      ? `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
      : `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const meta = await fetchJSON(url);

    if (!meta) {
      findings.push('Package not found on npm registry');
      return { name, ecosystem: 'npm', risk: RISK_LEVEL.BLOCK, findings };
    }

    // For full package metadata (no version), get the latest info
    const latest = meta.versions
      ? meta.versions[meta['dist-tags']?.latest] || meta
      : meta;
    const distTags = meta['dist-tags'] || {};
    const allVersions = meta.versions ? Object.keys(meta.versions) : [];
    const timeMap = meta.time || {};

    // 1. Package age — when was it first published?
    const created = timeMap.created ? new Date(timeMap.created) : null;
    const now = new Date();
    if (created) {
      const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
      if (ageDays < 7) {
        findings.push(`Very new package — created ${ageDays} day(s) ago`);
        riskLevel = RISK_LEVEL.BLOCK;
      } else if (ageDays < 30) {
        findings.push(`New package — created ${ageDays} days ago`);
        if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
      }
    }

    // 2. Specific version age
    const requestedVersion = version || distTags.latest;
    const versionPublished = timeMap[requestedVersion] ? new Date(timeMap[requestedVersion]) : null;
    if (versionPublished) {
      const versionAgeDays = Math.floor((now - versionPublished) / (1000 * 60 * 60 * 24));
      if (versionAgeDays < 3) {
        findings.push(`This version published ${versionAgeDays} day(s) ago — extremely fresh`);
        riskLevel = RISK_LEVEL.BLOCK;
      } else if (versionAgeDays < 14) {
        findings.push(`This version published ${versionAgeDays} days ago`);
        if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
      }
    }

    // 3. Maintainer count
    const maintainers = meta.maintainers || [];
    if (maintainers.length === 0) {
      findings.push('No listed maintainers');
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    // 4. Version count — single-version packages are riskier
    if (allVersions.length === 1) {
      findings.push('Only 1 version ever published');
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    // 5. Install scripts — postinstall/preinstall can execute arbitrary code
    const scripts = latest.scripts || {};
    const dangerousScripts = ['preinstall', 'install', 'postinstall'].filter(s => scripts[s]);
    if (dangerousScripts.length > 0) {
      findings.push(`Has install scripts: ${dangerousScripts.join(', ')} — "${dangerousScripts.map(s => scripts[s]).join('; ')}"`);
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    // 6. Typosquatting check
    const typo = checkTyposquat(name, POPULAR_NPM);
    if (typo.suspect) {
      findings.push(`Possible typosquat of "${typo.similar_to}" (distance: ${typo.distance}${typo.pattern ? ', ' + typo.pattern : ''})`);
      riskLevel = RISK_LEVEL.BLOCK;
    }

    // 7. Deprecated
    if (latest.deprecated) {
      findings.push(`Deprecated: ${latest.deprecated}`);
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    // 8. Check npm audit advisories via bulk endpoint
    try {
      const auditData = await fetchNpmAudit(name, requestedVersion || distTags.latest || '0.0.0');
      if (auditData && auditData.length > 0) {
        for (const adv of auditData.slice(0, 3)) {
          findings.push(`Known vulnerability: ${adv.title} (${adv.severity}) — ${adv.url || ''}`);
        }
        const hasCritical = auditData.some(a => a.severity === 'critical' || a.severity === 'high');
        if (hasCritical) riskLevel = RISK_LEVEL.BLOCK;
        else if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
      }
    } catch { /* audit check is best-effort */ }

    if (findings.length === 0) {
      findings.push('No issues detected');
    }

    return { name, version: requestedVersion, ecosystem: 'npm', risk: riskLevel, findings, maintainers: maintainers.length, versions: allVersions.length };
  } catch (e) {
    // Registry unreachable — allow with warning rather than blocking all installs
    findings.push(`Registry check failed: ${e.message}`);
    return { name, ecosystem: 'npm', risk: RISK_LEVEL.WARN, findings };
  }
}

async function fetchNpmAudit(name, version) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ [name]: [version] });
    const req = https.request({
      hostname: 'registry.npmjs.org',
      path: '/-/npm/v1/security/advisories/bulk',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const advisories = [];
          for (const [, advList] of Object.entries(json)) {
            if (Array.isArray(advList)) {
              for (const adv of advList) {
                advisories.push({
                  title: adv.title || adv.module_name || 'Unknown',
                  severity: adv.severity || 'unknown',
                  url: adv.url || '',
                  vulnerable_versions: adv.vulnerable_versions || '',
                });
              }
            }
          }
          resolve(advisories);
        } catch { resolve([]); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

async function vetPipPackage(name, version) {
  const findings = [];
  let riskLevel = RISK_LEVEL.OK;

  try {
    const url = version
      ? `https://pypi.org/pypi/${encodeURIComponent(name)}/${version}/json`
      : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const meta = await fetchJSON(url);

    if (!meta) {
      findings.push('Package not found on PyPI');
      return { name, ecosystem: 'pip', risk: RISK_LEVEL.BLOCK, findings };
    }

    const info = meta.info || {};
    const releases = meta.releases || {};
    const allVersions = Object.keys(releases);

    // 1. Package creation date — use earliest release
    const allDates = [];
    for (const files of Object.values(releases)) {
      if (Array.isArray(files)) {
        for (const f of files) {
          if (f.upload_time_iso_8601) allDates.push(new Date(f.upload_time_iso_8601));
          else if (f.upload_time) allDates.push(new Date(f.upload_time));
        }
      }
    }
    allDates.sort((a, b) => a - b);
    const now = new Date();

    if (allDates.length > 0) {
      const ageDays = Math.floor((now - allDates[0]) / (1000 * 60 * 60 * 24));
      if (ageDays < 7) {
        findings.push(`Very new package — first published ${ageDays} day(s) ago`);
        riskLevel = RISK_LEVEL.BLOCK;
      } else if (ageDays < 30) {
        findings.push(`New package — first published ${ageDays} days ago`);
        if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
      }
    }

    // 2. Latest release age
    if (allDates.length > 0) {
      const latestDate = allDates[allDates.length - 1];
      const latestAgeDays = Math.floor((now - latestDate) / (1000 * 60 * 60 * 24));
      if (latestAgeDays < 3) {
        findings.push(`Latest release published ${latestAgeDays} day(s) ago — extremely fresh`);
        if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
      }
    }

    // 3. Version count
    if (allVersions.length === 1) {
      findings.push('Only 1 version ever published');
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    // 4. Author info
    if (!info.author && !info.author_email && !info.maintainer) {
      findings.push('No author/maintainer information');
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    // 5. Typosquatting
    const typo = checkTyposquat(name, POPULAR_PIP);
    if (typo.suspect) {
      findings.push(`Possible typosquat of "${typo.similar_to}" (distance: ${typo.distance}${typo.pattern ? ', ' + typo.pattern : ''})`);
      riskLevel = RISK_LEVEL.BLOCK;
    }

    // 6. Yanked version
    const requestedVersion = version || info.version;
    const releaseFiles = releases[requestedVersion] || [];
    if (releaseFiles.length > 0 && releaseFiles.every(f => f.yanked)) {
      findings.push('This version has been yanked (removed by maintainer)');
      riskLevel = RISK_LEVEL.BLOCK;
    }

    // 7. Check OSV.dev for known vulnerabilities
    try {
      const vulns = await fetchOsvVulns('PyPI', name, requestedVersion || info.version);
      if (vulns && vulns.length > 0) {
        for (const v of vulns.slice(0, 3)) {
          findings.push(`Known vulnerability: ${v.id} — ${v.summary || ''}`);
        }
        riskLevel = RISK_LEVEL.BLOCK;
      }
    } catch { /* best-effort */ }

    // 8. setup.py / setup.cfg install hooks aren't easily detectable from PyPI,
    // but we can flag packages that bundle native extensions
    if (releaseFiles.some(f => f.packagetype === 'sdist') && !releaseFiles.some(f => f.packagetype === 'bdist_wheel')) {
      findings.push('No wheel available — installs from source (runs setup.py)');
      if (riskLevel !== RISK_LEVEL.BLOCK) riskLevel = RISK_LEVEL.WARN;
    }

    if (findings.length === 0) {
      findings.push('No issues detected');
    }

    return { name, version: requestedVersion, ecosystem: 'pip', risk: riskLevel, findings, versions: allVersions.length };
  } catch (e) {
    findings.push(`Registry check failed: ${e.message}`);
    return { name, ecosystem: 'pip', risk: RISK_LEVEL.WARN, findings };
  }
}

function fetchOsvVulns(ecosystem, name, version) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version,
      package: { name, ecosystem },
    });
    const req = https.request({
      hostname: 'api.osv.dev',
      path: '/v1/query',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve((json.vulns || []).map(v => ({ id: v.id, summary: (v.summary || '').substring(0, 200) })));
        } catch { resolve([]); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

/**
 * Parse an install command and extract package names + versions.
 * Returns null if the command isn't a package install.
 */
function parseInstallCommand(command) {
  const trimmed = command.trim();

  // npm install / npm i / npm add
  const npmMatch = trimmed.match(/\b(?:npm|npx)\s+(?:install|i|add)\s+(.*)/);
  if (npmMatch) {
    const args = npmMatch[1];
    const packages = [];
    // Split on whitespace, skip flags
    for (const token of args.split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!token) continue;
      // @scope/name@version or name@version or name
      const atIdx = token.lastIndexOf('@');
      if (atIdx > 0) {
        packages.push({ name: token.substring(0, atIdx), version: token.substring(atIdx + 1), ecosystem: 'npm' });
      } else {
        packages.push({ name: token, version: null, ecosystem: 'npm' });
      }
    }
    return packages.length > 0 ? packages : null;
  }

  // yarn add
  const yarnMatch = trimmed.match(/\byarn\s+add\s+(.*)/);
  if (yarnMatch) {
    const packages = [];
    for (const token of yarnMatch[1].split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!token) continue;
      const atIdx = token.lastIndexOf('@');
      if (atIdx > 0) {
        packages.push({ name: token.substring(0, atIdx), version: token.substring(atIdx + 1), ecosystem: 'npm' });
      } else {
        packages.push({ name: token, version: null, ecosystem: 'npm' });
      }
    }
    return packages.length > 0 ? packages : null;
  }

  // pnpm add
  const pnpmMatch = trimmed.match(/\bpnpm\s+(?:add|install)\s+(.*)/);
  if (pnpmMatch) {
    const packages = [];
    for (const token of pnpmMatch[1].split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!token) continue;
      const atIdx = token.lastIndexOf('@');
      if (atIdx > 0) {
        packages.push({ name: token.substring(0, atIdx), version: token.substring(atIdx + 1), ecosystem: 'npm' });
      } else {
        packages.push({ name: token, version: null, ecosystem: 'npm' });
      }
    }
    return packages.length > 0 ? packages : null;
  }

  // pip install / pip3 install / python -m pip install
  const pipMatch = trimmed.match(/\b(?:pip3?|python3?\s+-m\s+pip|\/\.venv\/bin\/pip)\s+install\s+(.*)/);
  if (pipMatch) {
    const args = pipMatch[1];
    if (/\s-r\s|\s--requirement\s/.test(' ' + args)) return null; // -r installs from file, not parseable
    const packages = [];
    for (const token of args.split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!token) continue;
      if (token.startsWith('.') || token.startsWith('/') || token.endsWith('.whl') || token.endsWith('.tar.gz') || token.endsWith('.txt')) continue;
      // name==version, name>=version, name~=version, or just name
      const verMatch = token.match(/^([a-zA-Z0-9_.-]+(?:\[[a-zA-Z0-9_,.-]+\])?)[=<>~!]+(.+)/);
      if (verMatch) {
        packages.push({ name: verMatch[1].replace(/\[.*\]/, ''), version: verMatch[2], ecosystem: 'pip' });
      } else if (/^[a-zA-Z0-9_.-]+(\[.*\])?$/.test(token)) {
        packages.push({ name: token.replace(/\[.*\]/, ''), version: null, ecosystem: 'pip' });
      }
    }
    return packages.length > 0 ? packages : null;
  }

  // gem install
  const gemMatch = trimmed.match(/\bgem\s+install\s+(.*)/);
  if (gemMatch) {
    const packages = [];
    for (const token of gemMatch[1].split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!token) continue;
      packages.push({ name: token, version: null, ecosystem: 'gem' });
    }
    return packages.length > 0 ? packages : null;
  }

  // cargo install
  const cargoMatch = trimmed.match(/\bcargo\s+install\s+(.*)/);
  if (cargoMatch) {
    const packages = [];
    for (const token of cargoMatch[1].split(/\s+/)) {
      if (token.startsWith('-')) continue;
      if (!token) continue;
      packages.push({ name: token, version: null, ecosystem: 'cargo' });
    }
    return packages.length > 0 ? packages : null;
  }

  return null;
}

/**
 * Vet all packages in a parsed install command.
 * Returns { allowed: bool, results: [...], warnings: string, blocked: string }
 */
async function vetPackages(parsedPackages) {
  const results = [];
  const concurrent = parsedPackages.map(async (pkg) => {
    if (pkg.ecosystem === 'npm') return vetNpmPackage(pkg.name, pkg.version);
    if (pkg.ecosystem === 'pip') return vetPipPackage(pkg.name, pkg.version);
    // For unsupported ecosystems, do typosquat check only
    return { name: pkg.name, ecosystem: pkg.ecosystem, risk: RISK_LEVEL.OK, findings: ['Registry vetting not available for this ecosystem'] };
  });

  const settled = await Promise.allSettled(concurrent);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(s.value);
    else results.push({ name: '?', ecosystem: '?', risk: RISK_LEVEL.WARN, findings: [`Vet failed: ${s.reason?.message || 'unknown'}`] });
  }

  const blocked = results.filter(r => r.risk === RISK_LEVEL.BLOCK);
  const warned = results.filter(r => r.risk === RISK_LEVEL.WARN);

  let allowed = blocked.length === 0;
  let summary = '';

  if (blocked.length > 0) {
    summary += '🚫 BLOCKED packages:\n';
    for (const b of blocked) {
      summary += `  • ${b.name} (${b.ecosystem}): ${b.findings.join('; ')}\n`;
    }
  }
  if (warned.length > 0) {
    summary += '⚠️  Warnings:\n';
    for (const w of warned) {
      summary += `  • ${w.name} (${w.ecosystem}): ${w.findings.join('; ')}\n`;
    }
  }

  return { allowed, results, summary: summary || null, blocked: blocked.length, warned: warned.length };
}

module.exports = {
  parseInstallCommand,
  vetPackages,
  vetNpmPackage,
  vetPipPackage,
  checkTyposquat,
  RISK_LEVEL,
  POPULAR_NPM,
  POPULAR_PIP,
};
