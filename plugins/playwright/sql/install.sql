-- playwright install — adds playwright-specific aspect to the shared
-- ref-browser-automation node.

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-browser-automation', 'backend-playwright', 8, 'playwright');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='backend-playwright'), c, i, 'seed', 'playwright'
FROM (
  SELECT 'Playwright is the debugging browser backend. Live screencast preview, easier introspection, but more detectable than zendriver — picks up automation tells from headless mode and standard Chrome that anti-bot stacks fingerprint.' AS c, 9 AS i
  UNION ALL SELECT 'Selector strings: "playwright" or alias "pw". Pass backend:"playwright" to force this backend on a launch call. Use only on cooperative sites or when the screencast preview matters for debugging.', 8
  UNION ALL SELECT 'Implementation: an in-process Node session via the playwright npm package. No subprocess. Click uses page.click (CDP mouse), type uses page.locator.pressSequentially (real keys), scroll uses page.mouse.wheel.', 7
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-browser-automation' AND name='backend-playwright')
    AND extracted_with = 'playwright'
);
