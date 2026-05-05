-- browser-core uninstall — scoped to OWN rows only.
--
-- The plugin manager calls this both on real uninstall (operator
-- removes browser-core in Settings → Plugins) AND on schemaVersion
-- upgrade (uninstall, then re-run install at the new schema). On the
-- upgrade path, blanket-deleting the whole ref-browser-automation
-- node would also wipe zendriver / playwright contributions that
-- haven't changed schema — losing data we shouldn't touch.
--
-- So we only drop content tagged with extracted_with='browser-core'.
-- Backend plugins clean up their own rows via their own uninstall.sql.
-- The node + edge survive if any backend plugin still has aspects on
-- it; if not, the dangling node is harmless and cleaned up the next
-- time browser-core re-installs (its INSERT OR IGNORE re-creates the
-- node row, idempotently).

DELETE FROM attributes
WHERE aspect_id IN (
  SELECT id FROM aspects
  WHERE node_id='ref-browser-automation' AND extracted_with='browser-core'
);

DELETE FROM aspects
WHERE node_id='ref-browser-automation' AND extracted_with='browser-core';

-- Drop the spore-capability "Can launch a headless browser…" attribute
-- we contributed (extracted_with='browser-core'). The agent's
-- capabilities summary will lose the browser line until the plugin is
-- reinstalled — which is what we want, because the tool is gone too.
DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND extracted_with='browser-core';

-- Cross-node cleanup: drop our contribution to ref-web-search that
-- mentions "escalate to the browser tool". Without the browser tool
-- installed, that advice would be a lie.
DELETE FROM attributes
WHERE aspect_id IN (
  SELECT id FROM aspects WHERE node_id='ref-web-search' AND name='workflow_pattern'
)
  AND extracted_with='browser-core';

-- Drop our edge from spore → ref-browser-automation. (The node-level
-- conditional delete below also handles the case where no aspects
-- remain, but explicit edge drop avoids dangling edges if some other
-- plugin still has aspects on the node.)
DELETE FROM edges
WHERE source='spore' AND target='ref-browser-automation' AND extracted_with='browser-core';

-- Only drop the node itself if NO plugin (backend or otherwise) still
-- has aspects on it. This makes a real uninstall fully clean while a
-- schema upgrade leaves the shared node intact for the backends.
DELETE FROM edges
WHERE (source='ref-browser-automation' OR target='ref-browser-automation')
  AND NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-browser-automation');

DELETE FROM nodes
WHERE id='ref-browser-automation'
  AND NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-browser-automation');
