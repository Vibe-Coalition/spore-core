/**
 * SDK-based Notion MCP Client
 * 
 * Uses the official @modelcontextprotocol/sdk with StreamableHTTPClientTransport
 * per the Notion cookbook integration guide.
 * 
 * Usage: node sdk-client.js [search query]
 */

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamablehttp.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { loadTokens, refreshAccessToken, saveTokens, MCP_SERVER_URL, MCP_SSE_URL } = require("./oauth");

async function getValidTokens() {
  let tokens = loadTokens();
  if (!tokens) {
    console.error("No tokens found. Run auth-server.js first to authorize.");
    process.exit(1);
  }

  // Check if token is expired and refresh if needed
  if (tokens.expires_at && Date.now() > tokens.expires_at) {
    console.log("Token expired, refreshing...");
    tokens = await refreshAccessToken(tokens.refresh_token);
    if (!tokens) {
      console.error("Failed to refresh token. Re-authorize with auth-server.js");
      process.exit(1);
    }
    saveTokens(tokens);
  }

  return tokens;
}

async function main() {
  const query = process.argv[2] || "";
  const tokens = await getValidTokens();

  console.log("Connecting to Notion MCP via Streamable HTTP...");

  // Create the MCP client
  const client = new Client({
    name: "bfl-notion-skim",
    version: "1.0.0",
  });

  // Try Streamable HTTP first, fall back to SSE
  let transport;
  let connected = false;

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
        requestInit: {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
          },
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

  if (!connected) {
    console.error("Could not connect to Notion MCP");
    process.exit(1);
  }

  // List available tools
  console.log("\n📋 Available tools:");
  const tools = await client.listTools();
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 80) || "no description"}`);
  }

  if (query) {
    // Search for pages
    console.log(`\n🔍 Searching for: "${query}"`);
    const result = await client.callTool({
      name: "search",
      arguments: { query },
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    // List all pages (empty search)
    console.log("\n🔍 Listing all pages (empty search)...");
    const result = await client.callTool({
      name: "search",
      arguments: { query: "" },
    });
    console.log(JSON.stringify(result, null, 2));
  }

  await client.close();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});