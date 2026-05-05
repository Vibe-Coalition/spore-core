---
name: fb-marketplace
description: "Search Facebook Marketplace listings and monitor deals. Use when user asks to find things on Marketplace, look for deals, set up deal alerts, or buy used items locally."
---

# Facebook Marketplace

Authenticated Facebook Marketplace integration with deal monitoring, image analysis, and preference learning.

## Scripts

```bash
python3 /root/.openclaw/workspace/skills/fb-marketplace/scripts/fbm.py <command>
python3 /root/.openclaw/workspace/skills/fb-marketplace/scripts/monitor.py <command>
```

## Search (fbm.py)

| Command | Description |
|---------|-------------|
| `search <query>` | Search listings near Port Moody |
| `search <query> --days 1` | Only listings from last N days |
| `search <query> --min 50 --max 200` | Price filter |
| `search <query> --radius 25` | Search radius in km (default: 11) |
| `search <query> --sort price_asc` | Sort by price |
| `listing <id>` | Get full listing details + high-res photo URLs |
| `listing <id> --raw` | Just output photo URLs (for piping to image tool) |
| `set-cookies '<string>'` | Save browser cookies |

## Image Analysis

- Search results include thumbnail URLs (261x260) — OK for quick browsing
- For proper analysis, use `listing <id> --raw` to get full-res photos (720p/960p)
- Pipe photo URLs to the `image` tool for style/quality analysis
- When monitoring, fetch full-res photos before evaluating against preferences

## Deal Monitor (monitor.py)

### Watch Management
| Command | Description |
|---------|-------------|
| `watch add "query" --max 200 --radius 20` | Create a deal watch |
| `watch list` | List all active watches |
| `watch remove <id>` | Remove a watch |
| `watch update <id> --max 300` | Update watch params |

### Preference Learning
| Command | Description |
|---------|-------------|
| `learn <id> "prefer mid-century modern"` | Add style preference |
| `learn <id> "no glass tops"` | Add negative preference |
| `learn <id> "under $50 is a great deal"` | Add price context |

Preferences are stored per-watch and persist across restarts. They are included in monitor output so the AI can filter/rank listings intelligently.

### Monitoring
| Command | Description |
|---------|-------------|
| `check [id]` | Check one/all watches for new listings |
| `seen <id>` | Show previously seen listings |
| `clear-seen <id>` | Reset seen listings |
| `report` | Full status of all watches |

### How Monitoring Works
1. User creates a watch with `watch add`
2. Cron runs `check` every hour
3. New listings (never seen before) are reported
4. User gives feedback via `learn` to refine preferences
5. Preferences are included in monitor output for AI to filter/rank
6. For visual items (furniture, rugs), use `listing <id> --raw` + image tool to verify style match

### Cron Setup
A single cron runs `monitor.py check` hourly for ALL watches. The cron job ID is `fb-marketplace-kilim-monitor` (name is legacy — covers all watches).

### Deduplication
- Every listing ID is tracked in `monitor_data/seen.json`
- Once seen, a listing NEVER appears again
- Seen data persists across restarts
- `clear-seen <id>` resets if user wants a fresh start

### Active Watches (as of 2026-03-19)
- `fcaa6092` — "kilim rug" (colorful Maimana on light bg, 6x9+, handwoven)
- `ffc88ea7` — "afghan rug" (same prefs as kilim)
- `97a3439b` — "coffee table" (wood, MCM, minimal, ≤$300, no glass/marble/live-edge)
- `f34896f7` — "4k projector" (name brand, 4K, no UST, no cheap brands, ≤$1500)

## Auth
Cookie-based. Key cookies: `c_user`, `xs`, `datr`, `sb`, `fr`
Stored at: `scripts/fbm_cookies.txt`

### Auto-Login (Cookie Refresh)
When cookies expire (monitor outputs `COOKIES_EXPIRED`):
1. Run: `python3 scripts/fb_login.py --check` to confirm expiry
2. If `NEEDS_BROWSER_LOGIN`: use browser tool to automate Facebook login
   - Navigate to facebook.com/login
   - Fill email/password from `scripts/fb_creds.json`
   - Handle 2FA if prompted (ask user)
   - Extract cookies from browser session
   - Save to `scripts/fbm_cookies.txt`
3. Credentials stored in `scripts/fb_creds.json` (gitignored, chmod 600)
4. Set creds: `python3 scripts/fb_login.py --set-creds` or have agent write fb_creds.json directly

### Cookie Expiry Detection
- Monitor `_search_and_filter()` detects "Log in to continue" responses
- Returns `AUTH_ERROR` → monitor outputs `COOKIES_EXPIRED`
- Hourly cron alerts user and suggests auto-refresh

## Location
Default: Port Moody, BC (49.29, -122.85)
Override per-search: `--lat` and `--lng`

## GraphQL Details
- Endpoint: `https://www.facebook.com/api/graphql/`
- doc_id: `26058421810481206` (CometMarketplaceSearchContentPaginationQuery)
- Requires: `fb_dtsg` token (auto-fetched from marketplace page)
- Auth: cookie-based session (`c_user`, `xs`)

## Rules
- Always provide direct Facebook links so user can tap to view/message
- Sort by `price_asc` when user asks for cheapest/best deal
- Use `--days` filter for recent/new listings
- When presenting monitored results, USE watch preferences to evaluate
- For visual items, fetch full-res photos with `listing` command before judging style
- Cookies expire periodically — user re-pastes from browser
