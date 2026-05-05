/**
 * Crawl3 — Robust Notion workspace crawler
 * - Creates fresh MCP client every 8 calls to avoid session timeouts
 * - Properly parses SSE/MCP responses
 * - Fetches pages AND databases
 * - Saves everything to crawl-output3.json
 */

const fs = require("fs");
const {
  createMcpClient,
  loadTokens,
  refreshAccessToken,
  saveTokens,
} = require("./oauth");

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";
const OUTPUT_FILE = "crawl-output3.json";
const PROGRESS_FILE = "crawl-progress3.log";

let callCount = 0;
let client = null;

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(PROGRESS_FILE, `[${ts}] ${msg}\n`);
}

async function getClient(tokens) {
  if (!client || callCount >= 8) {
    if (client) log("(reconnecting MCP session)");
    client = await createMcpClient(MCP_SERVER_URL, tokens.access_token);
    callCount = 0;
  }
  return client;
}

async function mcpCall(tokens, method, params) {
  const c = await getClient(tokens);
  callCount++;
  try {
    const r = await c.callMethod("tools/call", params);
    const data = r.result || r;
    const text = data?.content?.[0]?.text || "";
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    // If token expired, refresh and retry once
    if (e.message?.includes("401") || e.message?.includes("unauthorized")) {
      log("(token expired, refreshing...)");
      tokens = await refreshAccessToken(
        tokens.refresh_token,
        tokens.metadata,
        tokens.client_id
      );
      tokens.metadata = tokens.metadata || loadTokens().metadata;
      tokens.client_id = tokens.client_id || loadTokens().client_id;
      saveTokens(tokens);
      client = null;
      callCount = 0;
      const c2 = await getClient(tokens);
      callCount++;
      const r = await c2.callMethod("tools/call", params);
      const data = r.result || r;
      const text = data?.content?.[0]?.text || "";
      return text ? JSON.parse(text) : null;
    }
    log(`  MCP error: ${e.message?.substring(0, 100)}`);
    return null;
  }
}

const SEARCH_QUERIES = [
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "project", "team", "research", "finance", "marketing", "engineering",
  "design", "product", "backend", "frontend", "infra", "model", "flux",
  "video", "image", "api", "server", "data", "meeting", "notes",
  "okr", "goal", "sprint", "roadmap", "hire", "people", "policy",
  "BFL", "FLUX", "generation", "safety", "legal", "ops", "sales",
];

(async () => {
  fs.writeFileSync(PROGRESS_FILE, "");
  
  let tokens = loadTokens();
  if (!tokens?.access_token) {
    log("No tokens! Run OAuth first.");
    process.exit(1);
  }

  // ── Phase 1: Search to discover all pages and databases ──
  log("Phase 1: Searching with " + SEARCH_QUERIES.length + " queries...");
  const allItems = new Map();
  
  for (const q of SEARCH_QUERIES) {
    try {
      const result = await mcpCall(tokens, "tools/call", {
        name: "notion-search",
        arguments: { query: q },
      });
      if (!result?.results) continue;
      
      for (const item of result.results) {
        allItems.set(item.id, {
          id: item.id,
          title: item.title || "(untitled)",
          url: item.url,
          type: item.type,
        });
      }
      
      const pages = result.results.filter(r => r.type === "page").length;
      const dbs = result.results.filter(r => r.type === "database").length;
      log(`  "${q}" -> ${pages} pages, ${dbs} dbs (total unique: ${allItems.size})`);
    } catch (e) {
      log(`  "${q}" -> error: ${e.message?.substring(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  const pages = [...allItems.values()].filter(i => i.type === "page");
  const databases = [...allItems.values()].filter(i => i.type === "database");
  log(`Phase 1 done: ${pages.length} pages, ${databases.length} databases, ${allItems.size} total items`);

  // ── Phase 2: Fetch every page and database ──
  log("Phase 2: Fetching " + pages.length + " pages and " + databases.length + " databases...");
  const pageContents = {};
  const dbContents = {};
  
  // Fetch pages
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    try {
      const result = await mcpCall(tokens, "tools/call", {
        name: "notion-fetch",
        arguments: { id: p.id },
      });
      if (result) {
        pageContents[p.id] = {
          id: p.id,
          title: p.title,
          url: p.url,
          metadata: result.metadata,
          text: result.text,
          raw: result,
        };
        const preview = (result.text || "").substring(0, 80).replace(/\n/g, " ");
        log(`  [${i+1}/${pages.length}] Page: ${p.title} -> ${preview}...`);
      }
    } catch (e) {
      log(`  [${i+1}/${pages.length}] Page: ${p.title} -> error: ${e.message?.substring(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Fetch databases
  for (let i = 0; i < databases.length; i++) {
    const db = databases[i];
    try {
      const result = await mcpCall(tokens, "tools/call", {
        name: "notion-fetch",
        arguments: { id: db.id },
      });
      if (result) {
        dbContents[db.id] = {
          id: db.id,
          title: db.title,
          url: db.url,
          metadata: result.metadata,
          text: result.text,
          raw: result,
        };
        log(`  [${i+1}/${databases.length}] DB: ${db.title} -> fetched`);
      }
    } catch (e) {
      log(`  [${i+1}/${databases.length}] DB: ${db.title} -> error: ${e.message?.substring(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Phase 3: Save output ──
  log("Phase 3: Saving output...");
  const output = {
    stats: {
      totalItems: allItems.size,
      totalPages: pages.length,
      totalDatabases: databases.length,
      fetchedPages: Object.keys(pageContents).length,
      fetchedDatabases: Object.keys(dbContents).length,
    },
    pages: pageContents,
    databases: dbContents,
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  log(`Done! Output saved to ${OUTPUT_FILE}`);
  log(`Stats: ${JSON.stringify(output.stats)}`);
})();