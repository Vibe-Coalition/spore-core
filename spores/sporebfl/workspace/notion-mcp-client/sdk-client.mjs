/**
 * SDK-based Notion MCP Client
 * 
 * Uses the official @modelcontextprotocol/sdk with StreamableHTTPClientTransport
 * per the Notion cookbook integration guide.
 * 
 * Usage: node sdk-client.mjs [search query]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFileSync, writeFileSync } from "fs";

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";
const MCP_SSE_URL = "https://mcp.notion.com/sse";

// Inline token helpers since oauth.js is CJS
const TOKENS_PATH = new URL(".tokens.json", import.meta.url).pathname;

function loadTokensSync() {
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveTokensSync(tokens) {
  if (!tokens.expires_at && tokens.expires_in) {
    tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  }
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

async function refreshTok(refreshToken) {
  const tokens = loadTokensSync();
  const meta = tokens.metadata || {};
  
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: tokens.client_id,
  });

  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const newTokens = await res.json();
  newTokens.metadata = meta;
  newTokens.client_id = tokens.client_id;
  return newTokens;
}

async function getValidTokens() {
  let tokens = loadTokensSync();
  if (!tokens) {
    console.error("No tokens found. Run auth-server.js first.");
    process.exit(1);
  }

  if (tokens.expires_at && Date.now() > tokens.expires_at) {
    console.log("Token expired, refreshing...");
    try {
      tokens = await refreshTok(tokens.refresh_token);
      saveTokensSync(tokens);
    } catch (e) {
      console.error("Refresh failed:", e.message);
      process.exit(1);
    }
  }

  return tokens;
}

async function main() {
  const query = process.argv[2] || "";
  const tokens = await getValidTokens();

  console.log("Connecting to Notion MCP via Streamable HTTP...");

  const client = new Client({
    name: "bfl-notion-skim",
    version: "1.0.0",
  });

  let transport;
  let connected = false;

  // Try Streamable HTTP first
  try {
    transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      },
    });
    await client.connect(transport);
    connected = true;
    console.log("✅ Connected via Streamable HTTP");
  } catch (e) {
    console.log(`Streamable HTTP failed: ${e.message}`);
    console.log("Falling back to SSE...");

    try {
      transport = new SSEClientTransport(new URL(MCP_SSE_URL), {
        eventSourceInit: {
          fetch: (url, init) => fetch(url, {
            ...init,
            headers: {
              ...init?.headers,
              Authorization: `Bearer ${tokens.access_token}`,
            },
          }),
        },
      });
      await client.connect(transport);
      connected = true;
      console.log("✅ Connected via SSE");
    } catch (e2) {
      console.error(`SSE also failed: ${e2.message}`);
      process.exit(1);
    }
  }

  // List available tools
  console.log("\n📋 Available tools:");
  const tools = await client.listTools();
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 100) || "no desc"}`);
  }

  // Search
  const searchQuery = query || "";
  console.log(`\n🔍 Searching for: "${searchQuery || "(all)"}"`);
  const result = await client.callTool({
    name: "notion-search",
    arguments: {
      search_type: "internal",
      query: searchQuery,
    },
  });
  console.log(JSON.stringify(result, null, 2));

  await client.close();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});