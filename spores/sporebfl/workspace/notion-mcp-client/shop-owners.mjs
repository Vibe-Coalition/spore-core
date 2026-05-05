import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";

function loadTokens() {
  return JSON.parse(readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8"));
}

async function refreshToken(tokens) {
  const resp = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${tokens.client_id}:${tokens.client_secret}`).toString("base64")}`,
    },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  });
  const newTokens = await resp.json();
  const merged = { ...tokens, ...newTokens };
  writeFileSync("/workspace/notion-mcp-client/.tokens.json", JSON.stringify(merged, null, 2));
  return merged;
}

async function connectClient(tokens) {
  const client = new Client({ name: "bfl-shop-meta", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  await client.connect(transport);
  return client;
}

// Shop pages found from search
const shopPages = [
  { id: "334c3702-22d5-80d3-8cff-da9474ba375d", title: "Research Shops (parent)" },
  { id: "312c3702-22d5-80a6-841f-c2a6312f0ed1", title: "Shop proposals" },
  { id: "321c3702-22d5-819d-8cfc-d10f572da3f5", title: "[not-a-shop] Shop Compute Needs" },
  { id: "32ec3702-22d5-80cd-a806-c600a8e064ad", title: "[Product Shop] Standard User Interface for Video Models" },
  { id: "313c3702-22d5-801a-ae92-f5db34024447", title: "Physical AI / Action Prediction / Robotics" },
  { id: "314c3702-22d5-80b5-a75c-d5220967f94c", title: "Lower-Precision Training for Diffusion Models" },
  { id: "317c3702-22d5-805f-bac6-fb1734902f80", title: "VAE/SSL Pre-training" },
  { id: "320c3702-22d5-8092-b251-d017aabfbaca", title: "Initial Research shop list" },
  { id: "33cc3702-22d5-808c-a0dd-f293f2e1e324", title: "Product <> FDE Weekly - April 15" },
  { id: "334c3702-22d5-80f3-af53-ec86a80a608e", title: "Product Eng Weekly Sync - April 14" },
  { id: "33cc3702-22d5-8123-910f-d469ee0d959e", title: "RL Research Shop Presentation" },
];

async function fetchPageMetadata(client, pageId, title) {
  try {
    const result = await client.callTool({
      name: "notion-fetch",
      arguments: { id: pageId },
    });

    for (const item of result.content) {
      if (item.type === "text") {
        const text = item.text;
        const meta = {};

        // Try to extract metadata patterns
        const patterns = {
          created_by: [
            /created[_-]?by[^}]*?(?:name["\s:]+["']([^"']+)["'])/i,
            /Created by[:\s]+([^\n,]+)/i,
          ],
          last_edited_by: [
            /last[_-]?edited[_-]?by[^}]*?(?:name["\s:]+["']([^"']+)["'])/i,
            /Last edited by[:\s]+([^\n,]+)/i,
          ],
        };

        for (const [key, regexes] of Object.entries(patterns)) {
          for (const regex of regexes) {
            const match = text.match(regex);
            if (match) { meta[key] = match[1]; break; }
          }
        }

        // Extract ancestor path
        const ancestorMatch = text.match(/ancestor-path[^]*?<parent-page[^>]*>([^<]+)/s);
        if (ancestorMatch) meta.parent_page = ancestorMatch[1].trim();

        // Save first 800 chars for context
        meta.content_preview = text.substring(0, 800);

        return meta;
      }
    }
  } catch (e) {
    return { error: e.message };
  }
  return {};
}

async function main() {
  let tokens = loadTokens();
  let client;
  try {
    client = await connectClient(tokens);
  } catch (e) {
    console.log("Token expired, refreshing...");
    tokens = await refreshToken(tokens);
    client = await connectClient(tokens);
  }

  console.log("✅ Connected\n");

  // Fetch Research Shops parent to discover all sub-shops
  console.log("📋 Fetching Research Shops parent page...\n");
  const parentResult = await client.callTool({
    name: "notion-fetch",
    arguments: { id: "334c3702-22d5-80d3-8cff-da9474ba375d" },
  });

  for (const item of parentResult.content) {
    if (item.type === "text") {
      const subPageMatches = [...item.text.matchAll(/\[([^\]]+)\]\(https:\/\/www\.notion\.so\/([a-f0-9-]+)\)/g)];
      console.log(`Found ${subPageMatches.length} sub-page links:\n`);
      for (const m of subPageMatches) {
        if (!shopPages.find(p => p.id === m[2])) {
          shopPages.push({ id: m[2], title: m[1] });
        }
        console.log(`  - [${m[1]}] (ID: ${m[2]})`);
      }
      console.log();
    }
  }

  // Now fetch metadata for all shop pages
  console.log(`📄 Fetching metadata for ${shopPages.length} shop pages...\n`);
  const results = [];

  for (const page of shopPages) {
    console.log(`📄 ${page.title}`);
    const meta = await fetchPageMetadata(client, page.id, page.title);
    results.push({ ...page, ...meta });

    if (meta.created_by) console.log(`   👤 Created by: ${meta.created_by}`);
    if (meta.last_edited_by) console.log(`   ✏️  Last edited by: ${meta.last_edited_by}`);
    if (meta.parent_page) console.log(`   📁 Parent: ${meta.parent_page}`);
    if (meta.error) console.log(`   ❌ Error: ${meta.error}`);
    console.log();

    await new Promise(r => setTimeout(r, 800));
  }

  writeFileSync("/workspace/notion-mcp-client/shop-owners.json", JSON.stringify(results, null, 2));
  console.log("💾 Saved to shop-owners.json");

  await client.close();
}

main().catch(e => console.error(e));