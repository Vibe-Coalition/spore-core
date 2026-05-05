import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";
const tokens = JSON.parse(readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8"));

const client = new Client({ name: "bfl-index", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
  requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
});

await client.connect(transport);
console.log("✅ Connected\n");

const queries = [
  "a", "e", "i", "o", "u",
  "project", "team", "meeting", "doc", "plan", "infra",
  "research", "product", "design", "engineering", "marketing",
  "finance", "hiring", "onboarding", "flux", "training",
  "backend", "ops", "sales", "partner", "data", "model",
  "guide", "process", "review", "api", "cloud", "compute",
];

const allPages = new Map();

function parseResults(text) {
  const results = [];
  const jsonMatch = text.match(/\{"results":\[/);
  if (!jsonMatch) return results;
  const jsonStr = text.substring(jsonMatch.index);
  let depth = 0, end = 0;
  for (let i = 0; i < jsonStr.length; i++) {
    if (jsonStr[i] === '{') depth++;
    if (jsonStr[i] === '}') depth--;
    if (depth === 0 && i > 0) { end = i + 1; break; }
  }
  try {
    const parsed = JSON.parse(jsonStr.substring(0, end));
    return parsed.results || [];
  } catch { return results; }
}

for (const q of queries) {
  try {
    const result = await client.callTool({
      name: "notion-search",
      arguments: { search_type: "internal", query: q },
    });
    for (const item of result.content) {
      if (item.type !== "text") continue;
      const results = parseResults(item.text);
      for (const r of results) {
        if (!allPages.has(r.id)) {
          allPages.set(r.id, { id: r.id, title: r.title || "(untitled)", url: r.url, type: r.type });
        }
      }
    }
    process.stdout.write(".");
  } catch (e) {
    process.stdout.write("x");
  }
}

console.log(`\n\n📊 Found ${allPages.size} unique pages/databases\n`);

const sorted = [...allPages.values()].sort((a, b) => a.title.localeCompare(b.title));
const pages = sorted.filter(p => p.type === "page");
const databases = sorted.filter(p => p.type === "database");

console.log(`📖 Pages (${pages.length}):`);
for (const p of pages) console.log(`  • ${p.title} [${p.id}]`);

console.log(`\n🗄️  Databases (${databases.length}):`);
for (const d of databases) console.log(`  • ${d.title} [${d.id}]`);

writeFileSync("/workspace/notion-mcp-client/page-index.json", JSON.stringify(sorted, null, 2));
console.log(`\n💾 Saved to page-index.json`);