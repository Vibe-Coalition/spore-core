import { readFileSync, writeFileSync } from "fs";

function loadTokens() {
  return JSON.parse(readFileSync("/workspace/notion-mcp-client/.tokens.json", "utf-8"));
}

function loadOAuthState() {
  return JSON.parse(readFileSync("/workspace/notion-mcp-client/oauth-state.json", "utf-8"));
}

async function refreshToken(tokens) {
  const state = loadOAuthState();
  const clientId = state.clientMetadata?.client_id;
  
  const resp = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Refresh failed ${resp.status}: ${body.substring(0, 300)}`);
  }
  const newTokens = await resp.json();
  const merged = { ...tokens, ...newTokens };
  writeFileSync("/workspace/notion-mcp-client/.tokens.json", JSON.stringify(merged, null, 2));
  return merged;
}

async function notionApiGet(tokens, path) {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (resp.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body.substring(0, 200)}`);
  }
  return resp.json();
}

// Shop page IDs
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

async function main() {
  let tokens = loadTokens();
  const results = [];
  
  for (const page of shopPages) {
    let retries = 0;
    while (retries < 2) {
      try {
        const data = await notionApiGet(tokens, `/pages/${page.id}`);
        
        const info = {
          id: page.id,
          title: page.title,
          created_time: data.created_time,
          last_edited_time: data.last_edited_time,
          created_by_name: data.created_by?.name || "unknown",
          created_by_id: data.created_by?.id || null,
          last_edited_by_name: data.last_edited_by?.name || "unknown",
          last_edited_by_id: data.last_edited_by?.id || null,
          parent_type: data.parent?.type,
          parent_id: data.parent?.database_id || data.parent?.page_id || data.parent?.workspace,
          url: data.url,
        };
        
        results.push(info);
        console.log(`📄 ${page.title}`);
        console.log(`   👤 Created by: ${info.created_by_name}`);
        console.log(`   ✏️  Last edited by: ${info.last_edited_by_name}`);
        console.log(`   📅 Created: ${info.created_time}`);
        console.log(`   📅 Last edited: ${info.last_edited_time}`);
        console.log(`   📁 Parent: ${info.parent_type} → ${info.parent_id}`);
        console.log();
        break;
        
      } catch (e) {
        if (e.message === "TOKEN_EXPIRED" && retries === 0) {
          console.log("Token expired, refreshing...");
          tokens = await refreshToken(tokens);
          retries++;
        } else {
          console.log(`❌ ${page.title}: ${e.message}`);
          results.push({ id: page.id, title: page.title, error: e.message });
          break;
        }
      }
    }
    
    await new Promise(r => setTimeout(r, 350));
  }
  
  writeFileSync("/workspace/notion-mcp-client/shop-owners.json", JSON.stringify(results, null, 2));
  console.log("\n💾 Saved to shop-owners.json");
}

main().catch(e => console.error(e));