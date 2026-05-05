/**
 * Notion Remote MCP — OAuth2 + PKCE Client
 * 
 * Handles the full OAuth flow:
 *   1. OAuth discovery (RFC 9470 + RFC 8414)
 *   2. PKCE parameter generation
 *   3. Dynamic client registration
 *   4. Authorization URL construction
 *   5. Token exchange
 *   6. Token refresh
 */

const crypto = require("crypto");

const MCP_SERVER_URL = "https://mcp.notion.com/mcp";
const MCP_SSE_URL = "https://mcp.notion.com/sse";

// ─── Helpers ────────────────────────────────────────────────────────────────

function base64URLEncode(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64URLEncode(crypto.createHash("sha256").update(verifier).digest());
}

function generateState() {
  return base64URLEncode(crypto.randomBytes(32));
}

// ─── Step 1: OAuth Discovery ────────────────────────────────────────────────

async function discoverOAuthConfig(serverUrl = MCP_SERVER_URL) {
  // RFC 9470: Protected Resource Metadata
  const resourceMetaUrl = `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`;
  const resourceMeta = await fetch(resourceMetaUrl).then(r => r.json());
  
  console.log("[discovery] Protected resource metadata:", JSON.stringify(resourceMeta, null, 2));
  
  const authServers = resourceMeta.authorization_servers;
  if (!authServers || authServers.length === 0) {
    throw new Error("No authorization servers found in protected resource metadata");
  }
  
  // RFC 8414: Authorization Server Metadata
  const authServerUrl = authServers[0];
  const metadataUrl = `${authServerUrl}/.well-known/oauth-authorization-server`;
  // Some servers use the base URL directly
  let metadata;
  try {
    metadata = await fetch(metadataUrl).then(r => r.json());
  } catch {
    metadata = await fetch(`${authServerUrl.replace(/\/$/, '')}`).then(r => r.json());
  }
  
  console.log("[discovery] Authorization server metadata:", JSON.stringify(metadata, null, 2));
  
  return {
    resourceMeta,
    metadata,
  };
}

// ─── Step 3: Dynamic Client Registration ────────────────────────────────────

async function registerClient(metadata, redirectUris) {
  const registrationEndpoint = metadata.registration_endpoint;
  if (!registrationEndpoint) {
    throw new Error("No registration_endpoint found in authorization server metadata");
  }
  
  const body = {
    client_name: "Sporebfl - BFL Company AI",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none", // public client (PKCE)
  };
  
  console.log("[registration] Registering client at:", registrationEndpoint);
  
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Client registration failed (${response.status}): ${errorText}`);
  }
  
  const clientInfo = await response.json();
  console.log("[registration] Client registered. client_id:", clientInfo.client_id);
  
  return clientInfo;
}

// ─── Step 4: Build Authorization URL ────────────────────────────────────────

function buildAuthorizationUrl(metadata, clientId, redirectUri, codeChallenge, state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: state,
  });
  
  const authUrl = `${metadata.authorization_endpoint}?${params.toString()}`;
  return authUrl;
}

// ─── Step 5: Exchange Code for Tokens ───────────────────────────────────────

async function exchangeCodeForTokens(code, codeVerifier, metadata, clientId, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  
  console.log("[token] Exchanging authorization code for tokens...");
  
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }
  
  const tokens = await response.json();
  console.log("[token] Access token received. Expires in:", tokens.expires_in, "seconds");
  
  return tokens;
}

// ─── Step 8: Refresh Token ──────────────────────────────────────────────────

async function refreshAccessToken(refreshToken, metadata, clientId) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  
  console.log("[refresh] Refreshing access token...");
  
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }
  
  const tokens = await response.json();
  console.log("[refresh] Token refreshed. Expires in:", tokens.expires_in, "seconds");
  
  return tokens;
}

// ─── MCP Client: Connect and List Tools ─────────────────────────────────────

async function createMcpClient(serverUrl, accessToken, useSse = false) {
  const endpoint = useSse ? MCP_SSE_URL : serverUrl;
  
  // For Streamable HTTP, we send JSON-RPC requests
  // For SSE, we'd need an EventSource — simpler to use Streamable HTTP
  
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  
  let sessionId = null;
  
  async function callMethod(method, params = {}) {
    const requestId = Date.now();
    const body = {
      jsonrpc: "2.0",
      id: requestId,
      method: method,
      params: params,
    };
    
    const reqHeaders = { ...headers };
    if (sessionId) {
      reqHeaders["Mcp-Session-Id"] = sessionId;
    }
    
    const response = await fetch(endpoint, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
    });
    
    // Capture session ID from response headers
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) {
      sessionId = newSessionId;
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MCP call failed (${response.status}): ${errorText}`);
    }
    
    const text = await response.text();
    let result;
    
    // Parse SSE response format: "event: message\ndata: {...}\n\n"
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const dataLine = text.split("\n").find(l => l.startsWith("data:"));
      if (dataLine) {
        result = JSON.parse(dataLine.substring(5).trim());
      } else {
        throw new Error("SSE response missing data line: " + text.substring(0, 200));
      }
    } else {
      result = JSON.parse(text);
    }
    
    if (result.error) {
      throw new Error(`MCP error: ${result.error.message}`);
    }
    
    return result;
  }
  
  // Initialize the session
  console.log("[mcp] Initializing session...");
  const initResult = await callMethod("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "sporebfl-notion-client",
      version: "1.0.0",
    },
  });
  const initData = initResult.result || initResult;
  console.log("[mcp] Server info:", initData?.serverInfo?.name, initData?.serverInfo?.version);
  
  // List available tools
  console.log("[mcp] Listing tools...");
  const toolsResult = await callMethod("tools/list", {});
  const toolsData = toolsResult.result || toolsResult;
  const tools = toolsData?.tools || [];
  console.log("[mcp] Available tools:", tools.map(t => t.name).join(", "));
  
  return {
    callMethod,
    tools,
    // Convenience methods
    search: (query) => callMethod("tools/call", { name: "search", arguments: { query } }),
    readPage: (pageId) => callMethod("tools/call", { name: "read-page", arguments: { pageId } }),
    listBlocks: (blockId) => callMethod("tools/call", { name: "list-blocks", arguments: { blockId } }),
  };
}

// ─── Token Persistence ──────────────────────────────────────────────────────

const fs = require("fs");
const TOKEN_PATH = "/workspace/notion-mcp-client/.tokens.json";

function saveTokens(tokens) {
  const data = {
    ...tokens,
    saved_at: Date.now(),
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
  console.log("[persist] Tokens saved.");
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  const data = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  console.log("[persist] Tokens loaded from cache.");
  return data;
}

// ─── Save OAuth State ───────────────────────────────────────────────────────

const STATE_PATH = "/workspace/notion-mcp-client/.oauth-state.json";

function saveOAuthState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadOAuthState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  MCP_SERVER_URL,
  MCP_SSE_URL,
  discoverOAuthConfig,
  registerClient,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  createMcpClient,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  saveTokens,
  loadTokens,
  saveOAuthState,
  loadOAuthState,
};