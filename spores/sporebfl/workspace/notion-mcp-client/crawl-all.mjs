/**
 * Crawl all Notion pages and save content
 * 
 * Reads page-index.json, fetches every page via notion-fetch,
 * saves raw content to crawled-pages.json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";

function loadTokens() {
  return JSON.parse(readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8"));
}

async function main() {
  const tokens = loadTokens();
  const index = JSON.parse(readFileSync("/workspace/notion-mcp-client/page-index.json", "utf-8"));
  
  console.log(`📋 Index has ${index.length} items to crawl\n`);

  const client = new Client({ name: "bfl-crawl", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  });

  await client.connect(transport);
  console.log("✅ Connected to Notion MCP\n");

  const crawled = [];
  let errors = 0;

  for (let i = 0; i < index.length; i++) {
    const item = index[i];
    const id = item.id.replace(/-/g, "");
    const pct = ((i + 1) / index.length * 100).toFixed(1);
    
    try {
      process.stdout.write(`[${pct}%] Fetching: ${item.title} (${item.type}) ... `);
      
      const result = await client.callTool({
        name: "notion-fetch",
        arguments: { id },
      });

      let textContent = "";
      for (const c of result.content) {
        if (c.type === "text") textContent += c.text;
      }

      crawled.push({
        id: item.id,
        title: item.title,
        type: item.type,
        content: textContent,
        crawledAt: new Date().toISOString(),
      });

      // Save incrementally after each page
      writeFileSync("/workspace/notion-mcp-client/crawled-pages.json", JSON.stringify(crawled, null, 2));
      
      console.log(`✅ (${textContent.length} chars)`);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      errors++;
      console.log(`❌ ${e.message?.substring(0, 100) || "error"}`);
      crawled.push({
        id: item.id,
        title: item.title,
        type: item.type,
        content: null,
        error: e.message?.substring(0, 200),
        crawledAt: new Date().toISOString(),
      });
      writeFileSync("/workspace/notion-mcp-client/crawled-pages.json", JSON.stringify(crawled, null, 2));
    }
  }

  console.log(`\n🏁 Done! Crawled ${crawled.length} pages (${errors} errors)`);
  console.log(`💾 Saved to crawled-pages.json`);
  
  // Summary
  const withContent = crawled.filter(p => p.content);
  const totalChars = withContent.reduce((sum, p) => sum + p.content.length, 0);
  console.log(`📊 ${withContent.length} pages with content, ${totalChars.toLocaleString()} total chars`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });