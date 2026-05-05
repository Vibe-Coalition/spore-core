#!/usr/bin/env node
/**
 * Crawl the entire Notion workspace and output structured JSON
 * 
 * Usage: node crawl.js > crawl-output.json
 * 
 * Outputs JSON to stdout with all pages, databases, and their content.
 * Progress logs go to stderr.
 */

const { createMcpClient, loadTokens } = require("./oauth");
const fs = require("fs");

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";

async function search(client, query) {
  const r = await client.callMethod("tools/call", {
    name: "notion-search",
    arguments: { query },
  });
  const content = r?.result?.content || r?.content;
  if (!content || !Array.isArray(content)) return { results: [] };
  
  const textItem = content.find(c => c.type === "text");
  if (!textItem) return { results: [] };
  
  try {
    return JSON.parse(textItem.text);
  } catch {
    return { results: [] };
  }
}

async function fetchPage(client, pageId) {
  try {
    const r = await client.callMethod("tools/call", {
      name: "notion-fetch",
      arguments: { id: pageId },
    });
    const content = r?.result?.content || r?.content;
    if (!content || !Array.isArray(content)) return null;
    
    const textItem = content.find(c => c.type === "text");
    if (!textItem) return null;
    
    try {
      return JSON.parse(textItem.text);
    } catch {
      return { raw: textItem.text };
    }
  } catch (e) {
    console.error(`[fetch] Error fetching ${pageIdOrUrl}: ${e.message}`);
    return null;
  }
}

async function queryDatabase(client, databaseId) {
  try {
    const r = await client.callMethod("tools/call", {
      name: "notion-query-data-sources",
      arguments: { data_source_id: databaseId },
    });
    const content = r?.result?.content || r?.content;
    if (!content || !Array.isArray(content)) return null;
    
    const textItem = content.find(c => c.type === "text");
    if (!textItem) return null;
    
    try {
      return JSON.parse(textItem.text);
    } catch {
      return { raw: textItem.text };
    }
  } catch (e) {
    console.error(`[query] Error querying database ${databaseId}: ${e.message}`);
    return null;
  }
}

async function main() {
  const tokens = loadTokens();
  if (!tokens) {
    console.error("No tokens found. Run OAuth flow first.");
    process.exit(1);
  }
  
  const client = await createMcpClient(MCP_SERVER_URL, tokens.access_token);
  
  const allPages = new Map();
  const allDatabases = new Map();
  const pageContents = new Map();
  const databaseContents = new Map();
  
  // Phase 1: Search with many queries to discover all pages
  const searchQueries = [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "project", "team", "research", "finance", "backend", "engineering",
    "meeting", "notes", "roadmap", "design", "model", "flux", "api",
    "infra", "product", "video", "image", "ml", "ai", "data", "cloud",
    "server", "deploy", "test", "doc", "spec", "plan", "goal", "okr",
    "hiring", "people", "org", "marketing", "sales", "gtm", "ops",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  ];
  
  console.error(`[search] Starting ${searchQueries.length} searches...`);
  
  for (const q of searchQueries) {
    try {
      const result = await search(client, q);
      const pages = result.results || [];
      
      for (const item of pages) {
        if (item.type === "page" && !allPages.has(item.id)) {
          allPages.set(item.id, item);
          const title = item.properties?.title?.title?.[0]?.plain_text || 
                        item.properties?.Name?.title?.[0]?.plain_text || item.title || id;
          console.error(`[search] Found page: ${title}`);
        } else if (item.type === "database" && !allDatabases.has(item.id)) {
          allDatabases.set(item.id, item);
          const title = item.title?.[0]?.plain_text || item.id;
          console.error(`[search] Found database: ${title}`);
        }
      }
    } catch (e) {
      console.error(`[search] Error for "${q}": ${e.message}`);
    }
  }
  
  console.error(`\n[summary] Found ${allPages.size} pages and ${allDatabases.size} databases\n`);
  
  // Phase 2: Fetch content of every page
  console.error(`[fetch] Fetching ${allPages.size} pages...`);
  let i = 0;
  for (const [id, page] of allPages) {
    i++;
    const title = page.properties?.title?.title?.[0]?.plain_text || 
                  page.properties?.Name?.title?.[0]?.plain_text || id;
    console.error(`[fetch] ${i}/${allPages.size}: ${title}`);
    
    try {
      const pageId = page.id || id;
      const content = await fetchPage(client, pageId);
      if (content) {
        pageContents.set(id, content);
      }
    } catch (e) {
      console.error(`[fetch] Error: ${e.message}`);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }
  
  // Phase 3: Query every database
  console.error(`\n[query] Querying ${allDatabases.size} databases...`);
  i = 0;
  for (const [id, db] of allDatabases) {
    i++;
    const title = db.title?.[0]?.plain_text || db.title || id;
    console.error(`[query] ${i}/${allDatabases.size}: ${title}`);
    
    try {
      const content = await queryDatabase(client, id);
      if (content) {
        databaseContents.set(id, content);
      }
    } catch (e) {
      console.error(`[query] Error: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 300));
  }
  
  // Phase 4: Also fetch pages found inside database results
  const dbPageIds = new Set();
  for (const [dbId, content] of databaseContents) {
    const results = content.results || [];
    for (const item of results) {
      if (item.type === "page" && !allPages.has(item.id)) {
        allPages.set(item.id, item);
        dbPageIds.add(item.id);
      }
    }
  }
  
  if (dbPageIds.size > 0) {
    console.error(`\n[fetch] Found ${dbPageIds.size} additional pages from databases, fetching...`);
    let j = 0;
    for (const id of dbPageIds) {
      j++;
      const page = allPages.get(id);
      const title = page?.properties?.title?.title?.[0]?.plain_text || 
                    page?.properties?.Name?.title?.[0]?.plain_text || id;
      console.error(`[fetch] ${j}/${dbPageIds.size}: ${title}`);
      
      try {
        const pageId = page?.id || id;
        const content = await fetchPage(client, pageId);
        if (content) {
          pageContents.set(id, content);
        }
      } catch (e) {
        console.error(`[fetch] Error: ${e.message}`);
      }
      
      await new Promise(r => setTimeout(r, 300));
    }
  }
  
  // Output everything as JSON to stdout
  const output = {
    crawled_at: new Date().toISOString(),
    stats: {
      pages: allPages.size,
      databases: allDatabases.size,
      pageContents: pageContents.size,
      databaseContents: databaseContents.size,
    },
    pages: Object.fromEntries(allPages),
    databases: Object.fromEntries(allDatabases),
    pageContents: Object.fromEntries(pageContents),
    databaseContents: Object.fromEntries(databaseContents),
  };
  
  // Write to file instead of stdout (too large)
  fs.writeFileSync("/workspace/notion-mcp-client/crawl-output.json", JSON.stringify(output));
  console.error(`\n[done] Crawl complete! Output saved to crawl-output.json`);
  console.error(`[done] Stats: ${allPages.size} pages, ${allDatabases.size} databases, ${pageContents.size} page contents, ${databaseContents.size} database contents`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});