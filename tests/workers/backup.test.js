'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { BackupWorker } = require('../../src/workers/backup');

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeGraphDb(file, nodeId) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      updated TEXT
    );
    INSERT INTO nodes (id, updated) VALUES ('${nodeId}', '2026-05-05T00:00:00.000Z');
  `);
  return db;
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-backup-'));
  const backupDir = path.join(dir, 'backups');
  const defaultPath = path.join(dir, 'default.db');
  const projectPath = path.join(dir, 'project.db');
  const defaultDb = makeGraphDb(defaultPath, 'default-node');
  makeGraphDb(projectPath, 'project-node').close();

  const paths = { default: defaultPath, project: projectPath };
  const registry = {
    list() {
      return [
        { slug: 'default', name: 'Default', role: 'main' },
        { slug: 'project', name: 'Project', role: 'project' },
      ];
    },
    getDbPath(slug) {
      return paths[slug] || null;
    },
    getActiveSlug() {
      return 'default';
    },
    refreshStats() {},
  };

  const worker = new BackupWorker({
    graphBackupEnabled: true,
    graphBackupOnChangeOnly: false,
    graphBackupRetention: 20,
    graphBackupDir: backupDir,
  }, log, defaultDb, defaultPath, registry);

  return {
    dir,
    backupDir,
    worker,
    cleanup() {
      try { defaultDb.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('multi-graph backups keep active-list compatibility and delete by graph slug', async () => {
  const fixture = makeFixture();
  try {
    const out = await fixture.worker.runBackups({ force: true, note: 'test' });
    assert.equal(out.ok, true);
    assert.equal(out.graphs.length, 2);

    const activeList = fixture.worker.listBackups();
    assert.equal(activeList.files.length, 1);
    assert.equal(activeList.files[0].slug, 'default');

    const allList = fixture.worker.listBackups({ all: true });
    assert.equal(allList.files.length, 2);
    assert.equal(allList.graphs.length, 2);

    const projectFile = allList.graphs.find(g => g.slug === 'project').files[0].file;
    const projectPath = path.join(fixture.backupDir, projectFile);
    assert.equal(fs.existsSync(projectPath), true);
    assert.equal(fs.existsSync(projectPath + '.json'), true);

    const del = fixture.worker.deleteBackup(projectFile, { slug: 'project' });
    assert.deepEqual(del, { ok: true, slug: 'project' });
    assert.equal(fs.existsSync(projectPath), false);
    assert.equal(fs.existsSync(projectPath + '.json'), false);
  } finally {
    fixture.cleanup();
  }
});
