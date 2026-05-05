#!/bin/bash
# SearXNG web search tool
# Usage: web-search "search query" [num_results]
# Uses the SearXNG instance at see.hyrule.vip

QUERY="$1"
COUNT="${2:-5}"

if [ -z "$QUERY" ]; then
  echo "Usage: web-search <query> [num_results]"
  exit 1
fi

# URL-encode the query
ENCODED_QUERY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")

# Fetch results from SearXNG
RESPONSE=$(curl -s --max-time 30 "https://see.hyrule.vip/search?q=${ENCODED_QUERY}&format=json&categories=general")

if [ $? -ne 0 ]; then
  echo "Error: Search request failed"
  exit 1
fi

# Parse and format results
echo "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])[:$COUNT]
if not results:
    print('No results found.')
    sys.exit(0)
for i, r in enumerate(results, 1):
    print(f'{i}. {r.get(\"title\", \"No title\")}')
    print(f'   URL: {r.get(\"url\", \"\")}')
    content = r.get('content', '')
    if content:
        print(f'   {content[:300]}')
    engines = r.get('engines', [])
    if engines:
        eng_str = ', '.join(engines)
        print(f'   Engines: {eng_str}')
    print()
print(f'Total results available: {data.get(\"number_of_results\", \"unknown\")}')
"
