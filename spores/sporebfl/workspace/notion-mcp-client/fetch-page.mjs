import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";

function loadTokens() {
  const raw = readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8");
  return JSON.parse(raw);
}

const tokens = loadTokens();
const pageId = process.argv[2] || "2b1c370222d58024ac2bc4efba011a5c"; // Research Infra

const client = new Client({ name: "bfl-fetch", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
  requestInit: {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  },
});

await client.connect(transport);
console.log("✅ Connected\n");

console.log(`📄 Fetching page: ${pageId}`);
const result = await client.callTool({
  name: "notion-fetch",
  arguments: {
    id: pageId,
  },
});

for (const item of result.content) {
  if (item.type === "text") {
    console.log(item.text);
  }
}