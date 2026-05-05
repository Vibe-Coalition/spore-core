# Default stdio transport (what you want for SPORE):
npx -y @notionhq/notion-mcp-server

# Explicitly specify stdio:
npx -y @notionhq/notion-mcp-server --transport stdio

# With env vars (for your child process spawn):
NOTION_TOKEN=ntn_**** npx -y @notionhq/notion-mcp-server
