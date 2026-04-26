#!/usr/bin/env node
/**
 * download-dataset.js — LongMemEval Dataset Downloader
 *
 * Fetches the LongMemEval dataset from HuggingFace and saves it locally.
 *
 * Usage:
 *   node download-dataset.js [oracle|s|m] [--out=<dir>]
 *
 * Variants:
 *   oracle  — Only evidence sessions (~15 MB). Default.
 *   s       — ~40 sessions per question (~277 MB)
 *   m       — ~500 sessions per question (~2.7 GB)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const VARIANTS = {
  oracle: {
    filename: 'longmemeval_oracle.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
    sizeHint: '~15 MB',
  },
  s: {
    filename: 'longmemeval_s_cleaned.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
    sizeHint: '~277 MB',
  },
  m: {
    filename: 'longmemeval_m_cleaned.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json',
    sizeHint: '~2.7 GB',
  },
};

function followRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers: { 'User-Agent': 'spore-benchmark/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(followRedirects(res.headers.location, maxRedirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function download(variant, outDir) {
  const spec = VARIANTS[variant];
  if (!spec) {
    console.error(`Unknown variant "${variant}". Use: oracle, s, or m`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const destPath = path.join(outDir, spec.filename);

  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    console.log(`  Already exists: ${destPath} (${(stat.size / 1e6).toFixed(1)} MB)`);
    return destPath;
  }

  console.log(`  Downloading ${variant} variant (${spec.sizeHint})...`);
  console.log(`  URL: ${spec.url}`);
  console.log(`  Dest: ${destPath}`);

  const res = await followRedirects(spec.url);
  const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0;
  let lastPct = -1;

  const ws = fs.createWriteStream(destPath + '.tmp');

  return new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      ws.write(chunk);
      downloaded += chunk.length;
      if (totalBytes > 0) {
        const pct = Math.floor((downloaded / totalBytes) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r  Progress: ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB)`);
          lastPct = pct;
        }
      } else {
        process.stdout.write(`\r  Downloaded: ${(downloaded / 1e6).toFixed(1)} MB`);
      }
    });
    res.on('end', () => {
      ws.end(() => {
        fs.renameSync(destPath + '.tmp', destPath);
        console.log(`\n  Saved: ${destPath} (${(downloaded / 1e6).toFixed(1)} MB)`);
        resolve(destPath);
      });
    });
    res.on('error', (err) => {
      ws.end();
      try { fs.unlinkSync(destPath + '.tmp'); } catch { /* silent: best-effort cleanup */ }
      reject(err);
    });
  });
}

/**
 * Resolve the dataset file path for a given variant + data directory.
 * Returns the path if it exists, or null.
 */
function resolveDatasetPath(variant, dataDir) {
  const spec = VARIANTS[variant];
  if (!spec) return null;
  const p = path.join(dataDir, spec.filename);
  return fs.existsSync(p) ? p : null;
}

module.exports = { download, resolveDatasetPath, VARIANTS };

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const variant = args.find(a => !a.startsWith('--')) || 'oracle';
  const outFlag = (args.find(a => a.startsWith('--out=')) || '').split('=')[1] || path.join(process.env.SPORE_DATA_DIR || '.', 'benchmark');

  console.log(`\n  LongMemEval Dataset Downloader`);
  console.log(`  ──────────────────────────────`);

  download(variant, outFlag)
    .then(() => { console.log('  Done.\n'); process.exit(0); })
    .catch(e => { console.error(`\n  Error: ${e.message}\n`); process.exit(1); });
}
