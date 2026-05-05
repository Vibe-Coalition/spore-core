/**
 * Auth Server — Runs a local HTTP server to handle the OAuth callback
 * 
 * Usage: node auth-server.js
 * 
 * This will:
 *   1. Discover Notion's OAuth config
 *   2. Register a dynamic client
 *   3. Print the authorization URL for you to visit
 *   4. Listen on port 3000 for the callback
 *   5. Exchange the code for tokens and save them
 */

const express = require("express");
const {
  discoverOAuthConfig,
  registerClient,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  saveTokens,
  saveOAuthState,
} = require("./oauth");

const PORT = process.env.OAUTH_PORT || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

async function main() {
  console.log("=== Notion Remote MCP — OAuth Setup ===\n");
  
  // Step 1: OAuth Discovery
  console.log("[1/5] Discovering OAuth configuration...");
  const { metadata } = await discoverOAuthConfig();
  
  // Step 2: Generate PKCE parameters
  console.log("[2/5] Generating PKCE parameters...");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  
  // Step 3: Dynamic Client Registration
  console.log("[3/5] Registering OAuth client...");
  const clientInfo = await registerClient(metadata, [REDIRECT_URI]);
  
  // Step 4: Build authorization URL
  const authUrl = buildAuthorizationUrl(
    metadata,
    clientInfo.client_id,
    REDIRECT_URI,
    codeChallenge,
    state
  );
  
  // Save state for the callback handler
  saveOAuthState({
    codeVerifier,
    state,
    clientId: clientInfo.client_id,
    clientSecret: clientInfo.client_secret,
    metadata,
    redirectUri: REDIRECT_URI,
  });
  
  // Step 5: Start server and wait for callback
  console.log("\n[4/5] Starting local callback server on port", PORT);
  console.log("[5/5] Open this URL in your browser to authorize:\n");
  console.log(authUrl);
  console.log("\nWaiting for callback...\n");
  
  const app = express();
  
  app.get("/callback", async (req, res) => {
    try {
      const { code, state: returnedState, error } = req.query;
      
      if (error) {
        res.send(`<h1>Authorization failed</h1><p>${error}</p>`);
        console.error("[callback] Error:", error);
        process.exit(1);
      }
      
      if (returnedState !== state) {
        res.send("<h1>State mismatch — possible CSRF attack</h1>");
        console.error("[callback] State mismatch!");
        process.exit(1);
      }
      
      console.log("[callback] Authorization code received, exchanging for tokens...");
      
      const tokens = await exchangeCodeForTokens(
        code,
        codeVerifier,
        metadata,
        clientInfo.client_id,
        REDIRECT_URI
      );
      
      saveTokens(tokens);
      
      res.send(`
        <h1>✅ Authorization successful!</h1>
        <p>Sporebfl is now connected to your Notion workspace.</p>
        <p>You can close this tab.</p>
      `);
      
      console.log("\n=== Authorization complete! ===");
      console.log("Tokens saved to .tokens.json");
      console.log("You can now run: node skim.js\n");
      
      // Exit after a short delay
      setTimeout(() => process.exit(0), 2000);
    } catch (err) {
      res.send(`<h1>Error</h1><p>${err.message}</p>`);
      console.error("[callback] Error:", err);
      process.exit(1);
    }
  });
  
  app.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}/callback`);
  });
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});