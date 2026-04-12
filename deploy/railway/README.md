# Railway Deployment

Deploy an Anima agent to Railway for a quick cloud-hosted setup with persistent memory.

1. Fork the Anima repo to your GitHub.
2. Create a new project on [Railway](https://railway.app).
3. Connect your GitHub repo as the source.
4. Set the root directory to the repo root.
5. Add environment variables:
   - `ANTHROPIC_API_KEY` (required)
   - `DISCORD_TOKEN` (if using Discord)
   - `AGENT_ID` (default: anima)
   - `ANIMA_DISPLAY_NAME`
   - `ANIMA_MODEL` (default: claude-sonnet-4-6)
   - `HEALTH_BIND_ADDR=0.0.0.0`
   - `MANAGER_SERVICE_KEY` (for inter-agent auth)
6. Add a persistent volume mounted at `/data` for graph.db and sessions.db.
7. Deploy.

Railway will use `railway.json` to build from the Dockerfile and health-check on `/health`.
