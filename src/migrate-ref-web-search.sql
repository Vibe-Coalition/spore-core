-- Idempotently add the Web Search & Fetch (web_search + web_fetch) reference
-- node onto installs that predate it. Re-running this migration is a no-op:
-- the node insert uses INSERT OR IGNORE, and each aspect/attribute is
-- guarded by WHERE NOT EXISTS so duplicates can't accumulate.
--
-- Also adds one cross-reference attribute to ref-spore-code-context.client_routing
-- so Spore Code agents see "use web_search for current info" alongside the local-
-- routing guidance.

-- ── Node + aspects ────────────────────────────────────────────────────

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-web-search', 'Web Search & Fetch (web_search + web_fetch)', 'reference',
  'Live-web information retrieval — web_search returns ranked results, web_fetch reads a specific URL. Routes through SearXNG (primary) with Brave fallback.', 9, 'seed');

-- when_to_use
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-web-search', 'when_to_use', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-web-search' AND name = 'when_to_use');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'when_to_use'),
       'USE web_search whenever the answer depends on current information — library versions, framework docs, API changes, recent events, error messages you have not seen before, "what is the latest", "what does X do", "is X deprecated". Your training data is stale; the web is not.', 10, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'when_to_use' AND a.content LIKE 'USE web_search whenever%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'when_to_use'),
       'USE web_fetch when you ALREADY have a URL (returned by web_search, mentioned by the user, or referenced from a file you read) and you want the page content. Do NOT web_search for a URL you already know — just web_fetch it.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'when_to_use' AND a.content LIKE 'USE web_fetch when you ALREADY have a URL%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'when_to_use'),
       'SKIP web_search for facts that are stable and inside your training (basic syntax, well-known algorithms, math). Burning a tool call on those is wasteful.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'when_to_use' AND a.content LIKE 'SKIP web_search for facts that are stable%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'when_to_use'),
       'SKIP web_search inside a `delegate_task({persona: "researcher", ...})` — the researcher persona has only web_search + web_fetch; if you are the researcher you should use them, but if you are the orchestrator, delegate parallel research instead of serial searches yourself.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'when_to_use' AND a.content LIKE 'SKIP web_search inside a `delegate_task%');

-- workflow_pattern
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-web-search', 'workflow_pattern', 8, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-web-search' AND name = 'workflow_pattern');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'workflow_pattern'),
       'Standard pattern: `web_search` broad → look at the top 5-10 results → pick 1-3 most authoritative URLs → `web_fetch` each. Don''t fetch all 10; pick the official docs / primary sources.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'workflow_pattern' AND a.content LIKE 'Standard pattern: `web_search` broad%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'workflow_pattern'),
       'Always include the current year in queries about recent topics ("expo router 2026", "React Native 0.76 breaking changes"). Without a year, search engines often return stale results from prior years that look authoritative but aren''t.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'workflow_pattern' AND a.content LIKE 'Always include the current year%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'workflow_pattern'),
       'Use site: filters for known trustworthy domains: `site:docs.expo.dev`, `site:github.com`, `site:stackoverflow.com`. Filters out SEO-spam blog posts that copy real docs out-of-date.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'workflow_pattern' AND a.content LIKE 'Use site: filters%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'workflow_pattern'),
       'For error messages, search the EXACT error string in quotes — `"TypeError: Cannot read properties of undefined" expo router`. The quotes pin the search to actual occurrences.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'workflow_pattern' AND a.content LIKE 'For error messages, search the EXACT%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'workflow_pattern'),
       'Authenticated APIs: `web_fetch({url: "...", credential: "BRAVE_API_KEY", method: "POST", body: {...}})` injects the vault key server-side without exposing it. The credential parameter is the vault key NAME (see ref-api-keys for the catalog).', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'workflow_pattern' AND a.content LIKE 'Authenticated APIs:%');

-- output_format
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-web-search', 'output_format', 7, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-web-search' AND name = 'output_format');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'output_format'),
       'web_search returns a list of {title, url, snippet} objects. Snippets are usually 1-2 sentences — use them to decide which URLs to fetch, not as the answer itself. Result count is capped (typically 10).', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'output_format' AND a.content LIKE 'web_search returns a list of%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'output_format'),
       'web_fetch returns the page content, capped at 30,000 chars. For longer pages, fetch a more specific URL (anchor / sub-page) rather than asking the same URL repeatedly. PDFs, JSON, and HTML are all supported.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'output_format' AND a.content LIKE 'web_fetch returns the page content%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'output_format'),
       'When citing a fact you got from the web, always include the source URL in your reply so the user can verify. Format: "Per <url>: <fact>" — keeps you honest and the user able to double-check.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'output_format' AND a.content LIKE 'When citing a fact you got from the web%');

-- backend
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-web-search', 'backend', 6, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-web-search' AND name = 'backend');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-web-search' AND name = 'backend'),
       'Primary backend: SearXNG self-hosted metasearch (set via SEARXNG_URL env). Fallback: Brave Search API (BRAVE_API_KEY). If web_search returns nothing useful, that''s usually a real "no good results" signal — not a backend problem. Log lines tell which backend served the query.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-web-search' AND asp.name = 'backend' AND a.content LIKE 'Primary backend: SearXNG%');

-- ── Cross-reference on ref-spore-code-context.client_routing ──────────────

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-spore-code-context' AND name = 'client_routing'),
       'For things you CAN''T learn from the user''s machine — current library versions, framework docs, error messages you''ve never seen, "is X deprecated", recent breaking changes — use `web_search` (then `web_fetch` the best 1-3 results). Don''t guess from training data; the web is more current. See ref-web-search for caps + workflow patterns.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-spore-code-context' AND asp.name = 'client_routing' AND a.content LIKE 'For things you CAN%t learn from the user%s machine%');
