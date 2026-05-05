import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";
const SHOP_PAGE_IDS = [
  "318c370222d5809babf2f69924809487",
  "313c370222d5818fbdb7cc35a1b3bdaf",
  "313c370222d580378dd7e9897a86f51c",
  "11ec370222d58020ad93e98fe0cc4607",
  "31ec370222d580c9a6dae762336ca46a",
  "321c370222d5819d8cfcd10f572da3f5",
  "318c370222d580deadddfb597eb422c8",
  "317c370222d5805fbac6fb1734902f80",
  "312c370222d5802fb959e806afad92c7",
  "313c370222d581ac89deeab10b6a5fd9",
  "316c370222d580ab8761e9ca36fb3f83",
  "313c370222d5801aae92f5db34024447",
  "317c370222d581d8ab46f94c28d831d3",
  "312c370222d58006b088ea540b42787c",
  "314c370222d580b5a75cd5220967f94c",
  "318c370222d580fd9c00df32187a4609",
  "316c370222d580a385ebf50a05f70883",
  "320c370222d58082b2aee88c4838623c",
];

async function main() {
  const tokens = JSON.parse(readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8"));
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  });
  const client = new Client({ name: "shop-crawl", version: "1.0.0" });
  await client.connect(transport);
  console.log("✅ Connected\n");

  const results = [];
  for (let i = 0; i < SHOP_PAGE_IDS.length; i++) {
    const pageId = SHOP_PAGE_IDS[i];
    try {
      console.log(`📄 [${i + 1}/${SHOP_PAGE_IDS.length}] Fetching ${pageId}...`);
      const result = await client.callTool({
        name: "notion-fetch",
        arguments: { id: pageId },
      });
      const text = result.content.map(c => c.text || "").join("\n");
      
      // Extract title from the returned content
      let title = `Unknown-${pageId.slice(0,8)}`;
      const titleMatch = text.match(/"title":"([^"]+)"/);
      if (titleMatch) title = titleMatch[1];
      
      results.push({ id: pageId, title, content: text, chars: text.length });
      console.log(`  ✅ ${title} (${text.length} chars)`);
      
      // Save incrementally
      writeFileSync("shop-proposals.json", JSON.stringify(results, null, 2));
      
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ❌ Failed: ${e.message}`);
      results.push({ id: pageId, title: `Failed-${pageId.slice(0,8)}`, error: e.message });
      writeFileSync("shop-proposals.json", JSON.stringify(results, null, 2));
    }
  }

  console.log(`\n💾 Saved ${results.length} shop proposals to shop-proposals.json`);
  await client.close();
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});