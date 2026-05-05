/**
 * Notion Workspace Crawler v2
 * Re-creates MCP session every 5 calls to avoid session timeouts
 */

const { createMcpClient, loadTokens } = require("./oauth");
const fs = require("fs");

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";
const OUTPUT_FILE = "crawl-output.json";
const PROGRESS_FILE = "crawl-progress2.log";

function log(msg) {
  const ts = new Date().toISOString().substr(11, 8);
  console.error(`[${ts}] ${msg}`);
  fs.appendFileSync(PROGRESS_FILE, `[${ts}] ${msg}\n`);
}

async function freshClient(tokens) {
  return await createMcpClient(MCP_SERVER_URL, tokens.access_token);
}

async function searchWithClient(client, query) {
  const r = await client.callMethod("tools/call", {
    name: "notion-search",
    arguments: { query },
  });
  const data = r.result || r;
  const text = data?.content?.[0]?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { results: [] };
  }
}

async function fetchPageWithClient(client, pageId) {
  const r = await client.callMethod("tools/call", {
    name: "notion-fetch",
    arguments: { url: `https://notion.so/${pageId.replace(/-/g, "")}` },
  });
  const data = r.result || r;
  const text = data?.content?.[0]?.text || "";
  return text;
}

async function queryDatabaseWithClient(client, databaseId) {
  const r = await client.callMethod("tools/call", {
    name: "notion-query-data-sources",
    arguments: { data_source_id: databaseId },
  });
  const data = r.result || r;
  const text = data?.content?.[0]?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { results: [] };
  }
}

(async () => {
  // Reset progress
  fs.writeFileSync(PROGRESS_FILE, "");

  const tokens = loadTokens();
  if (!tokens?.access_token) {
    log("No access token found!");
    process.exit(1);
  }

  const allItems = new Map();
  let callCount = 0;
  let client = await freshClient(tokens);

  // Phase 1: Search to discover all pages and databases
  const queries = [
    "project", "team", "research", "flux", "backend", "finance", "GTM",
    "engineering", "design", "marketing", "infra", "video", "editing",
    "model", "API", "platform", "product", "strategy", "roadmap",
    "hiring", "meeting", "sprint", "OKR", "launch", "demo",
    "milestone", "deadline", "BFL", "Kontext", "Pro", "Max",
    "Klein", "tools", "safety", "eval", "training", "data",
    "compute", "deploy", "release", "feature", "bug", "test",
    "UI", "UX", "frontend", "fullstack", "DevOps", "SRE",
    "sales", "revenue", "pricing", "customer", "partner",
  ];

  log(`Phase 1: Searching with ${queries.length} queries...`);

  for (const q of queries) {
    try {
      callCount++;
      if (callCount % 5 === 0) {
        log("Refreshing MCP session...");
        client = await freshClient(tokens);
      }
      const result = await searchWithClient(client, q);
      for (const item of (result.results || [])) {
        allItems.set(item.id, {
          id: item.id,
          title: item.title,
          url: item.url,
          type: item.type,
        });
      }
      log(`Search "${q}" -> ${result.results?.length || 0} results (total unique: ${allItems.size})`);
    } catch (e) {
      log(`Search error for "${q}": ${e.message}`);
      // Force refresh on error
      try { client = await freshClient(tokens); callCount = 0; } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  log(`Phase 1 complete: ${allItems.size} unique items found`);

  // Separate pages and databases
  const pages = [...allItems.values()].filter((i) => i.type === "page");
  const databases = [...allItems.values()].filter((i) => i.type === "database");

  log(`Pages: ${pages.length}, Databases: ${databases.length}`);

  // Phase 2: Fetch page contents
  const pageContents = {};
  callCount = 0;
  client = await freshClient(tokens);

  log(`Phase 2: Fetching ${pages.length} pages...`);

  for (const page of pages) {
    try {
      callCount++;
      if (callCount % 3 === 0) {
        log("Refreshing MCP session...");
        client = await freshClient(tokens);
      }
      const content = await fetchPageWithClient(client, page.id);
      pageContents[page.id] = {
        ...page,
        content: content.substring(0, 10000), // Cap at 10k chars per page
      };
      log(`Fetched page: ${page.title}`);
    } catch (e) {
      log(`Fetch error for page ${page.title}: ${e.message}`);
      try { client = await freshClient(tokens); callCount = 0; } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Phase 3: Query databases
  const dbContents = {};
  callCount = 0;
  client = await freshClient(tokens);

  log(`Phase 3: Querying ${databases.length} databases...`);

  for (const db of databases) {
    try {
      callCount++;
      if (callCount % 3 === 0) {
        log("Refreshing MCP session...");
        client = await freshClient(tokens);
      }
      const result = await queryDatabaseWithClient(client, db.id);
      dbContents[db.id] = {
        ...db,
        entries: result.results || [],
      };
      log(`Queried database: ${db.title} (${result.results?.length || 0} entries)`);
    } catch (e) {
      log(`Query error for database ${db.title}: ${e.message}`);
      try { client = await freshClient(tokens); callCount = 0; } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Save output
  const output = {
    stats: {
      totalItems: allItems.size,
      totalPages: pages.length,
      totalDatabases: databases.length,
      fetchedPages: Object.keys(pageContents).length,
      queriedDatabases: Object.keys(dbContents).length,
    },
    pages: pageContents,
    databases: dbContents,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  log(`Done! Output saved to ${OUTPUT_FILE}`);
  log(`Stats: ${JSON.stringify(output.stats)}`);
})();