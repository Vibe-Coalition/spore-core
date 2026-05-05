-- browser-core install.sql — owns the ref-browser-automation node and
-- the backend-agnostic aspects (action-style, discovery-hierarchy,
-- usage). Backend-specific aspects (stealth/playwright sections) are
-- contributed by the zendriver / playwright plugins via their own
-- install.sql, and removed via uninstall.sql when those plugins are
-- removed. So uninstalling a backend keeps the rest of the doc intact.

-- Legacy cleanup: pre-plugin versions of this graph were seeded from
-- src/reference-nodes.sql AND src/seed-graph.sql with extracted_with='seed'
-- on the ref-browser-automation node, plus a "Can launch a headless
-- browser…" capability on the spore self-node, plus a spore→
-- ref-browser-automation edge. All of those live in this plugin now;
-- drop the seed-tagged duplicates so plugin content is the single source.
DELETE FROM attributes
WHERE aspect_id IN (
  SELECT id FROM aspects
  WHERE node_id='ref-browser-automation' AND extracted_with='seed'
);
DELETE FROM aspects
WHERE node_id='ref-browser-automation' AND extracted_with='seed';
-- Drop the seed-tagged "headless browser" capability attribute from
-- the spore self-node so we can re-insert as plugin-owned below.
DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content LIKE 'Can launch a headless browser%';
-- Drop the seed-tagged spore→ref-browser-automation edge — we re-add
-- as plugin-owned at the bottom of this script.
DELETE FROM edges
WHERE source='spore' AND target='ref-browser-automation' AND extracted_with='seed';

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-browser-automation', 'Browser Automation', 'reference',
  'How to drive the built-in browser tool. Backend plugins (zendriver, playwright) register themselves; the browser-core plugin owns the `browser` tool surface and dispatches.', 8, 'browser-core');

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-browser-automation', 'action-style', 9, 'browser-core');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='action-style'), c, i, 'seed', 'browser-core'
FROM (
  SELECT 'click(selector) dispatches CDP Input.dispatchMouseEvent at the element''s coordinates: real mousedown / mousemove / mouseup with isTrusted=true. type(selector, text) dispatches CDP Input.dispatchKeyEvent per character: real keydown / keypress / input / change with isTrusted=true. scroll dispatches synthesizeScrollGesture (zendriver) or mouse.wheel (playwright): real WheelEvents.' AS c, 10 AS i
  UNION ALL SELECT 'evaluate(expression) is for READ-ONLY DOM inspection: extracting structured data, querying computed styles, debugging selectors. Setting values from JS (el.value="x"), calling el.click(), or dispatchEvent produces events with isTrusted=false — frameworks miss state updates and bot detection flags it. This is the #1 way the agent leaks automation through zendriver.', 10
  UNION ALL SELECT 'Common anti-pattern: 3+ evaluate calls to "find then set" a form field. If you can describe a CSS selector for the target, use type/click directly — the selector goes in the action call, not in JS that walks the tree.', 9
  UNION ALL SELECT 'screenshot also saves a JPG and returns filePath — use that for message_send (or just reply with the /workspace/... path in web chat).', 7
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='action-style')
    AND extracted_with = 'browser-core'
);

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-browser-automation', 'discovery-hierarchy', 9, 'browser-core');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='discovery-hierarchy'), c, i, 'seed', 'browser-core'
FROM (
  SELECT 'Discovery default: action:snapshot. One call returns {url, title, interactive: [{kind, selector, text, visible, in_viewport, href?, name?, type?, value?, options?}], headings: [...], content: {markdown, excerpt}}. interactive[] is sorted (in-viewport first, then visible) so the most useful targets come first. The same Readability extractor that web_fetch uses produces content.markdown — clean main-content text, not boilerplate. Pick the selector you need from interactive[] and pass it directly to click/type.' AS c, 10 AS i
  UNION ALL SELECT 'evaluate is the second tier: when snapshot doesn''t describe what you need (custom data-attr, computed style, a DOM query snapshot didn''t cover). Read-only. NEVER use evaluate to set values or call .click() — those events get isTrusted=false and are detected.', 9
  UNION ALL SELECT 'Screenshot + analyze_image (VLM) is a FALLBACK, not the default discovery method. The DOM is structured text — richer, cheaper, faster than re-rendering a screenshot through a vision model. Reach for screenshot+VLM only when snapshot/evaluate genuinely lack the info: canvas-rendered UIs, OCR-only / image-heavy sites, ad iframes you can''t reach, or layout you must verify visually.', 10
  UNION ALL SELECT 'Screenshot AS verification (after a click, did the right thing happen) is fine — quick, cheap. The anti-pattern is using screenshot+analyze_image as the PRIMARY way to read every page state.', 9
  UNION ALL SELECT 'Cost asymmetry: snapshot is ~200ms, ~1-3k tokens, deterministic. Screenshot+analyze_image is ~1-3s, ~2-5k tokens, vendored vision model, occasional hallucinations. Default to snapshot.', 8
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='discovery-hierarchy')
    AND extracted_with = 'browser-core'
);

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-browser-automation', 'tabs', 8, 'browser-core');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='tabs'), c, i, 'seed', 'browser-core'
FROM (
  SELECT 'Multi-tab workflows use tab_open / tab_list / tab_switch / tab_close. tab_open(url) creates a new tab and switches to it; tab_list returns [{index, url, title, active}]; tab_switch(index) retargets subsequent click/type/screenshot to that tab; tab_close(index?) closes a tab (default: current). The "active" tab is what every other action operates on.' AS c, 9 AS i
  UNION ALL SELECT 'When to use tabs: opening a result without losing the search list, comparing two pages side-by-side, parking an in-progress form while you check something else. status reports active_tab_index and tab_count. Closing the last tab errors — use action:close to stop the entire browser.', 8
  UNION ALL SELECT 'navigate vs tab_open: navigate replaces the URL of the active tab (loses history of where you were); tab_open keeps the current tab and opens the new url alongside it. If you might want to come back, prefer tab_open.', 8
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='tabs')
    AND extracted_with = 'browser-core'
);

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-browser-automation', 'usage', 7, 'browser-core');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='usage'), c, i, 'seed', 'browser-core'
FROM (
  SELECT 'Launch with browser({action:"launch", url:"..."}) — backend defaults to the instance setting (config.browserBackend). Pass backend:"<name>" to force a specific one when multiple are installed.' AS c, 8 AS i
  UNION ALL SELECT 'Closing the browser tears down the helper subprocess too, so any code update to the wrapper takes effect on the next launch. Don''t close unnecessarily — the session is meant to persist.', 7
  UNION ALL SELECT 'Action surface: launch, navigate, click, type, scroll, screenshot, evaluate, snapshot, tab_open, tab_list, tab_switch, tab_close, close, status. Same shape on every backend.', 8
  UNION ALL SELECT 'In the web panel, browser sessions stream live preview automatically. browser({action:"screenshot"}) also saves a JPG and returns filePath; in web chat, reply with that /workspace/... path so it renders inline.', 8
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='usage')
    AND extracted_with = 'browser-core'
);

-- Edge from the agent's self-node so this ref node surfaces in recall
-- when the agent is reasoning about web tasks.
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
SELECT 'spore', 'ref-browser-automation', 'documents', 0.8, 'browser-core'
WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-browser-automation');

-- Plugin-owned capability attribute on the spore self-node. This
-- mirrors the seed-graph pattern (lines 274-286) where each plugin
-- contributes a "Can …" line and uninstall removes it. The agent's
-- system prompt summarises these capabilities, so the line should
-- only be present while a browser backend is actually available.
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities'),
       'Can launch a headless browser to interact with web apps — click, type, scroll, snapshot pages, multi-tab. The browser tool routes to whichever backend plugin is installed (zendriver for stealth / anti-bot sites, playwright for debugging).',
       7, 'seed', 'browser-core'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
    AND extracted_with='browser-core'
);

-- Cross-node touchpoint: ref-web-search.workflow_pattern lists how to
-- read the live web. Without a browser tool the chain ends at
-- web_fetch (curl + Readability). With browser-core installed, JS-
-- rendered / login-walled / SPA pages can be escalated. Add the line
-- only if the target node exists (graphs without that ref-node skip).
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-web-search' AND name='workflow_pattern'),
       'When web_fetch returns suspicious-looking content (login wall, JS-required notice, near-empty body), escalate to the browser tool: launch the URL, snapshot the rendered page, then read content.markdown. The browser executes JS and follows redirects/auth flows that web_fetch can''t.',
       8, 'seed', 'browser-core'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-web-search' AND name='workflow_pattern')
  AND NOT EXISTS (
    SELECT 1 FROM attributes
    WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-web-search' AND name='workflow_pattern')
      AND extracted_with='browser-core'
  );
