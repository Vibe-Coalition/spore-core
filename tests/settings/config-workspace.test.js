/**
 * Regression coverage for Docker workspace derivation.
 *
 * A null workspacePath makes tool code fall back to process.cwd() (/app in
 * Docker), which caused bundled /app/tools source files to be saved as graph
 * tool nodes on first boot.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_KEYS = [
  'GRAPH_DB_PATH',
  'SESSION_DB_PATH',
  'SETTINGS_DB_PATH',
  'SPORE_DATA_DIR',
  'SPORE_WORKSPACE_PATH',
  'SPORE_SETTINGS_DUAL_RUN_ASSERT',
  'NODE_ENV',
];

function clearConfigModules() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/config') || k.includes('/src/settings/')) delete require.cache[k];
  }
}

function withEnv(env, fn) {
  const prev = new Map(ENV_KEYS.map(k => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    clearConfigModules();
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev.get(k) === undefined) delete process.env[k];
      else process.env[k] = prev.get(k);
    }
    clearConfigModules();
  }
}

test('Docker graph path derives /workspace and settings defaults do not erase it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-config-workspace-'));
  try {
    withEnv({
      GRAPH_DB_PATH: '/data/graph.db',
      SESSION_DB_PATH: path.join(tmp, 'sessions.db'),
      SETTINGS_DB_PATH: path.join(tmp, 'settings.db'),
      SPORE_DATA_DIR: tmp,
    }, () => {
      const { loadConfig } = require('../../src/config');
      const cfg = loadConfig();
      assert.equal(cfg.workspacePath, '/workspace');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('explicit SPORE_WORKSPACE_PATH still wins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-config-workspace-'));
  try {
    withEnv({
      GRAPH_DB_PATH: '/data/graph.db',
      SESSION_DB_PATH: path.join(tmp, 'sessions.db'),
      SETTINGS_DB_PATH: path.join(tmp, 'settings.db'),
      SPORE_DATA_DIR: tmp,
      SPORE_WORKSPACE_PATH: '/custom-workspace',
    }, () => {
      const { loadConfig } = require('../../src/config');
      const cfg = loadConfig();
      assert.equal(cfg.workspacePath, '/custom-workspace');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
