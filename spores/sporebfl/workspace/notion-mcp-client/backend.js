/**
 * Notion Remote MCP — Auth Backend
 * 
 * Runs behind web_serve as a backend process.
 * Exposes OAuth endpoints at /api/notion/*
 * 
 * Environment:
 *   PUBLIC_BASE_URL — the public URL base (e.g. https://myserver.com/spores/sporebfl)
 *   APP_PORT — set automatically by web_serve
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  discoverOAuthConfig,
  registerClient,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  createMcpConnection,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} = require("./oauth");

const TOKENS_PATH = path.join(__dirname, "tokens.json");
const STATE_PATH = path.join(__dirname, "oauth-state.json");

// ─── State ────────────────────────────────────────────────────────────────

let oauthState = null; // { clientMetadata, codeVerifier, state, redirectUri }

function loadSavedState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    }
  } catch (e) {}
  return null;
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    }
  } catch (e) {}
  return null;
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

// ─── Route handlers ───────────────────────────────────────────────────────

async function handleStart(req, res) {
  const publicBase = process.env.PUBLIC_BASE_URL;
  if (!publicBase) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "PUBLIC_BASE_URL env var not set" }));
    return;
  }

  const redirectUri = `${publicBase}/api/notion/callback`;

  // Step 1: Discover OAuth config
  const config = await discoverOAuthConfig("https://mcp.notion.com/mcp");

  // Step 2: Register client dynamically
  const clientMetadata = await registerClient(config.metadata, [redirectUri]);

  // Step 3: Generate PKCE params and build authorization URL
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authorizationUrl = buildAuthorizationUrl(
    config.metadata,
    clientMetadata.client_id,
    redirectUri,
    codeChallenge,
    state
  );

  // Save state for callback
  const stateData = { clientMetadata, codeVerifier, state, redirectUri, config };
  oauthState = stateData;
  saveState(stateData);

  console.log(`[notion-auth] Redirecting to: ${authorizationUrl}`);

  // Redirect the user to Notion's consent screen
  res.writeHead(302, { Location: authorizationUrl });
  res.end();
}

async function handleCallback(req, res) {
  const url = new URL(req.url, "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>${error}: ${url.searchParams.get("error_description")}</p>`);
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Missing authorization code</h1>");
    return;
  }

  // Load state
  const saved = oauthState || loadSavedState();
  if (!saved) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end("<h1>No OAuth state found. Start over at /api/notion/start</h1>");
    return;
  }

  if (state !== saved.state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>State mismatch — possible CSRF attack</h1>");
    return;
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      code,
      saved.codeVerifier,
      saved.config.metadata,
      saved.clientMetadata.client_id,
      saved.redirectUri
    );

    saveTokens(tokens);
    console.log("[notion-auth] Tokens saved successfully!");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <head><title>Notion Connected!</title></head>
        <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#eee">
          <div style="text-align:center">
            <h1 style="color:#7ee787">✅ Notion Connected!</h1>
            <p>Spore can now access your Notion workspace.</p>
            <p style="color:#888;font-size:0.9em">You can close this tab.</p>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("[notion-auth] Token exchange failed:", e.message);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Token exchange failed</h1><pre>${e.message}</pre>`);
  }
}

async function handleStatus(req, res) {
  const tokens = loadTokens();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    connected: !!tokens,
    hasAccessToken: !!tokens?.access_token,
    expiresAt: tokens?.expires_at || null,
  }));
}

async function handleSearch(req, res) {
  const tokens = loadTokens();
  if (!tokens) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not authenticated. Visit /api/notion/start first." }));
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams.get("q") || "";

  try {
    const conn = await createMcpConnection(tokens.access_token);

    // Use the search tool
    const result = await conn.callTool("search", { query });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    // If token expired, try refresh
    if (e.message?.includes("401") || e.message?.includes("unauthorized")) {
      const saved = oauthState || loadSavedState();
      if (saved && tokens.refresh_token) {
        try {
          const newTokens = await refreshAccessToken(
            tokens.refresh_token,
            saved.config.metadata,
            saved.clientMetadata.client_id
          );
          saveTokens(newTokens);

          // Retry with new token
          const conn = await createMcpConnection(newTokens.access_token);
          const result = await conn.callTool("search", { query });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        } catch (e2) {
          // Refresh failed, need re-auth
        }
      }
    }

    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === "/api/notion/start") {
      await handleStart(req, res);
    } else if (pathname === "/api/notion/callback") {
      await handleCallback(req, res);
    } else if (pathname === "/api/notion/status") {
      await handleStatus(req, res);
    } else if (pathname === "/api/notion/search") {
      await handleSearch(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (e) {
    console.error("[notion-auth] Unhandled error:", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = process.env.APP_PORT || 3099;
server.listen(PORT, () => {
  console.log(`[notion-auth] Backend listening on port ${PORT}`);
  console.log(`[notion-auth] Routes:`);
  console.log(`  GET /api/notion/start    — Begin OAuth flow`);
  console.log(`  GET /api/notion/callback — OAuth callback (Notion redirects here)`);
  console.log(`  GET /api/notion/status   — Check connection status`);
  console.log(`  GET /api/notion/search?q=query — Search Notion workspace`);
});