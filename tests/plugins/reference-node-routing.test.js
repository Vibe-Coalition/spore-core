const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { GraphRegistry } = require('../../src/graph/multi');
const { PluginManager } = require('../../src/plugins');

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function scalar(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).get(...params)?.value || 0;
  } finally {
    try { db.close(); } catch {}
  }
}

test('plugin reference nodes install into general knowledge and are cleaned from default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-plugin-ref-routing-'));
  const config = {
    dataDir: dir,
    graphDbPath: path.join(dir, 'graph.db'),
    agentId: 'spore',
    displayName: 'Spore',
  };
  const registry = new GraphRegistry(dir, config, logger());
  registry.init();

  const generalSlug = registry.getGeneralKnowledgeSlug();
  const mainSlug = registry.getMainSlug();
  const generalDbPath = registry.getDbPath(generalSlug);
  const mainDbPath = registry.getDbPath(mainSlug);
  assert.ok(generalDbPath);
  assert.ok(mainDbPath);
  assert.notEqual(generalDbPath, mainDbPath);

  const manager = new PluginManager(config, logger());
  manager._appContext = {
    config,
    tools: { _graphRegistry: registry },
    graph: { _graphRegistry: registry },
  };
  manager.plugins.set('fake-ref-plugin', {
    manifest: { version: '1.0.0' },
    instance: {
      getReferenceNodes() {
        return {
          schemaVersion: 1,
          install: { sql: `
            INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
            VALUES ('ref-fake-ref-plugin', 'Fake Reference Plugin', 'reference', 'test ref node', 7, '{{plugin_id}}');
          ` },
          uninstall: { sql: `
            DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE extracted_with='{{plugin_id}}')
              OR target IN (SELECT id FROM nodes WHERE extracted_with='{{plugin_id}}');
            DELETE FROM nodes WHERE extracted_with='{{plugin_id}}';
          ` },
        };
      },
    },
  });

  const mainDb = new DatabaseSync(mainDbPath);
  try {
    manager._ensurePluginInstallsTable(mainDb);
    mainDb.prepare(`
      INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
      VALUES ('ref-fake-ref-plugin', 'Stale Fake Reference Plugin', 'reference', 'stale default copy', 7, 'fake-ref-plugin')
    `).run();
    mainDb.prepare(`
      INSERT OR REPLACE INTO plugin_installs (plugin_id, schema_version, installed_at, manifest_version)
      VALUES ('fake-ref-plugin', 1, CURRENT_TIMESTAMP, '0.9.0')
    `).run();
  } finally {
    mainDb.close();
  }

  manager._runReferenceNodeInstalls();

  assert.equal(
    scalar(generalDbPath, "SELECT COUNT(*) AS value FROM nodes WHERE id='ref-fake-ref-plugin' AND extracted_with='fake-ref-plugin'"),
    1,
  );
  assert.equal(
    scalar(generalDbPath, "SELECT COUNT(*) AS value FROM plugin_installs WHERE plugin_id='fake-ref-plugin'"),
    1,
  );
  assert.equal(
    scalar(mainDbPath, "SELECT COUNT(*) AS value FROM nodes WHERE extracted_with='fake-ref-plugin'"),
    0,
  );
  assert.equal(
    scalar(mainDbPath, "SELECT COUNT(*) AS value FROM plugin_installs WHERE plugin_id='fake-ref-plugin'"),
    0,
  );
});
