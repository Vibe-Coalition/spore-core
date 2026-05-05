/**
 * Skim — Connect to Notion Remote MCP and browse your workspace
 * 
 * Usage: node skim.js [search query]
 * 
 * If tokens are expired, attempts automatic refresh.
 * If no tokens exist, tells you to run auth-server.js first.
 */

const {
  createMcpClient,
  loadTokens,
  saveTokens,
  refreshAccessToken,
  loadOAuthState,
  MCP_SERVER_URL,
  MCP_SSE_URL,
} = require("./oauth");

async function getValidTokens() {
  const tokens = loadTokens();
  if (!tokens) {
    console.error("No tokens found. Run `node auth-server.js` first to authorize.");
    process.exit(1);
  }
  
  // Check if token is expired (with 5 min buffer)
  const expiresAt = tokens.saved_at + (tokens.expires_in * 1000);
  const now = Date.now();
  const buffer = 5 * 60 * 1000; // 5 minutes
  
  if (now >= expiresAt - buffer) {
    console.log("[auth] Access token expired, refreshing...");
    const state = loadOAuthState();
    if (!state || !tokens.refresh_token) {
      console.error("Cannot refresh — no refresh token or OAuth state. Re-run auth-server.js");
      process.exit(1);
    }
    
    const newTokens = await refreshAccessToken(
      tokens.refresh_token,
      state.metadata,
      state.clientId
    );
    
    saveTokens(newTokens);
    return newTokens;
  }
  
  return tokens;
}

async function main() {
  const query = process.argv[2] || "";
  
  console.log("=== Notion Workspace Skimmer ===\n");
  
  const tokens = await getValidTokens();
  console.log("[connect] Connecting to Notion MCP...\n");
  
  let client;
  try {
    client = await createMcpClient(MCP_SERVER_URL, tokens.access_token, false);
  } catch (error) {
    console.warn("[connect] Streamable HTTP failed, trying SSE fallback...", error.message);
    client = await createMcpClient(MCP_SERVER_URL, tokens.access_token);
  }
  
  // Search or browse
  if (query) {
    console.log(`\n[search] Searching for: "${query}"...\n`);
    const results = await client.callMethod("tools/call", {
      name: "notion-search",
      arguments: { query },
    });
    const data = results.result || results;
    console.log(JSON.stringify(data, null, 2));
  } else {
    // List recent pages
    console.log("[browse] Fetching recent pages...\n");
    const results = await client.callMethod("tools/call", {
      name: "notion-search",
      arguments: { query: "" },
    });
    const data = results.result || results;
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});