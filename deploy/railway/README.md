# Railway Deployment

Railway is a quick way to run a small Spore Core instance with persistent data.
For production, prefer the Docker compose path in `deploy/README.md`.

## Steps

1. Create a Railway project from this repository.
2. Build from the repository root with `src/Dockerfile`.
3. Add a persistent volume mounted at `/data`.
4. Add a persistent volume mounted at `/workspace` if you want generated files
   and workspace state to survive redeploys.
5. Expose the web port you choose with `SPORE_WEB_PORT`.
6. Set provider/channel secrets in Railway variables or finish first-run
   onboarding in the web UI.

## Common Variables

```text
AGENT_ID=spore
SPORE_DISPLAY_NAME=Spore
SPORE_WEB_PORT=18803
SPORE_HEALTH_PORT=18790
HEALTH_BIND_ADDR=0.0.0.0
SPORE_DATA_DIR=/data
SPORE_WORKSPACE_PATH=/workspace
GRAPH_DB_PATH=/data/graph.db
SESSION_DB_PATH=/data/sessions.db
SPORE_PLUGINS_ENABLED=true
```

Optional provider/channel variables:

```text
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=
TELEGRAM_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
DISCORD_TOKEN=
```

## Notes

Railway should health-check `/health` on `SPORE_HEALTH_PORT`. The web UI and API
run on `SPORE_WEB_PORT`.

Back up the `/data` volume before resetting graphs, users, sessions, plugins, or
settings.
