-- zendriver install — adds zendriver-specific aspect to the
-- ref-browser-automation node owned by browser-core. The node is
-- assumed to exist (depends:browser-core in spore.plugin.json).
-- extracted_with='zendriver' tags rows so uninstall can drop just
-- our contributions, leaving browser-core's content intact.

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-browser-automation', 'backend-zendriver', 9, 'zendriver');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='backend-zendriver'), c, i, 'seed', 'zendriver'
FROM (
  SELECT 'Zendriver is the default browser backend. Stealth-patched Chromium driven over CDP — hides navigator.webdriver, fakes chrome.runtime, and synthesizes real OS-level keyboard/mouse events. The right backend for any site with anti-bot detection (Reddit, Cloudflare, Akamai, PerimeterX).' AS c, 10 AS i
  UNION ALL SELECT 'Selector strings: "zendriver" or alias "zd". Picked when config.browserBackend = "zendriver" (default), or when the agent explicitly passes backend:"zendriver" to a launch call.', 8
  UNION ALL SELECT 'Implementation: a Python helper subprocess (plugins/zendriver/helper/browser_helper.py) hosts the zendriver session. The Node side (plugins/zendriver/lib/backend.js) speaks JSON-RPC over stdin/stdout. Closing the browser tears down the helper too — any wrapper edit takes effect on next launch.', 7
  UNION ALL SELECT 'Stealth caveat: zendriver''s patches stay effective only when you drive with click / type / snapshot. JS-driven evaluate calls (el.value="x", el.click()) re-leak isTrusted=false events that bot detection still catches. The browser-core action-style guidance applies.', 9
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='backend-zendriver')
    AND extracted_with = 'zendriver'
);
