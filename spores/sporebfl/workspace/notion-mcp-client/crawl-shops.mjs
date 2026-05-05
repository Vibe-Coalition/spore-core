import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";

function loadTokens() {
  const raw = readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8");
  return JSON.parse(raw);
}

const SHOP_PROPOSALS_PAGE_ID = "312c370222d580a6841fc2a6312f0ed1";

async function main() {
  const tokens = loadTokens();
  const client = new Client({ name: "shop-crawl", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  });

  await client.connect(transport);
  console.log("✅ Connected\n");

  // Step 1: Fetch the Shop proposals parent page to discover sub-pages
  console.log(`📄 Fetching Shop proposals parent page...`);
  const parentResult = await client.callTool({
    name: "notion-fetch",
    arguments: { id: SHOP_PROPOSALS_PAGE_ID },
  });

  const parentText = parentResult.content.map(c => c.text || "").join("\n");
  console.log("Parent page content length:", parentText.length);
  
  // Extract sub-page URLs/IDs from the parent page
  const subPageRegex = /<sub-page url="https:\/\/www\.notion\.so\/([a-f0-9]+)"/g;
  const subPageIds = [];
  let match;
  while ((match = subPageRegex.exec(parentText)) !== null) {
    subPageIds.push(match[1]);
  }
  
  // Also extract linked-page references
  const linkedPageRegex = /<linked-page[^>]*url="https:\/\/www\.notion\.so\/([a-f0-9]+)"/g;
  while ((match = linkedPageRegex.exec(parentText)) !== null) {
    if (!subPageIds.includes(match[1])) {
      subPageIds.push(match[1]);
    }
  }

  console.log(`Found ${subPageIds.length} sub-pages under Shop proposals\n`);

  // Step 2: Fetch each sub-page
  const results = [];
  for (let i = 0; i < subPageIds.length; i++) {
    const pageId = subPageIds[i];
    try {
      console.log(`📄 [${i + 1}/${subPageIds.length}] Fetching ${pageId}...`);
      const result = await client.callTool({
        name: "notion-fetch",
        arguments: { id: pageId },
      });
      const text = result.content.map(c => c.text || "").join("\n");
      
      // Extract title
      const titleMatch = text.match(/"title":"([^"]+)"/);
      const title = titleMatch ? titleMatch[1] : `Shop ${pageId}`;
      
      results.push({ id: pageId, title, content: text });
      console.log(`  ✅ ${title} (${text.length} chars)`);
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  ❌ Failed: ${e.message}`);
      results.push({ id: pageId, title: `Failed: ${pageId}`, error: e.message });
    }
  }

  // Step 3: Save results
  writeFileSync("shop-proposals.json", JSON.stringify(results, null, 2));
  console.log(`\n💾 Saved ${results.length} shop proposals to shop-proposals.json`);
  
  // Also save the parent page
  writeFileSync("shop-proposals-parent.json", JSON.stringify({
    id: SHOP_PROPOSALS_PAGE_ID,
    title: "Shop proposals",
    content: parentText
  }, null, 2));

  await client.close();
  console.log("Done!");
}

main().catch(e => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});