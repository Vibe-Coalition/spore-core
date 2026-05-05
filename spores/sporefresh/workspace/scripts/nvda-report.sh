#!/usr/bin/env bash
# NVDA stock report → telegram channel-7d93be8439ca (PirateKing)
# Sends a one-liner with current price, change, and volume during US market hours.

set -euo pipefail

PORT="${SPORE_WEB_PORT:-18803}"
TARGET="telegram:697706930"

# Fetch NVDA quote from Yahoo Finance
JSON="$(curl -fsS --max-time 15 \
  'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=1d' \
  -H 'User-Agent: Mozilla/5.0' || true)"

if [[ -z "$JSON" ]]; then
  echo "$(date -Iseconds) fetch failed"
  exit 0
fi

# Extract fields with jq
PRICE=$(echo "$JSON"   | jq -r '.chart.result[0].meta.regularMarketPrice // empty')
PREV=$(echo "$JSON"    | jq -r '.chart.result[0].meta.chartPreviousClose // .chart.result[0].meta.previousClose // empty')
HIGH=$(echo "$JSON"    | jq -r '.chart.result[0].meta.regularMarketDayHigh // empty')
LOW=$(echo "$JSON"     | jq -r '.chart.result[0].meta.regularMarketDayLow // empty')
VOL=$(echo "$JSON"     | jq -r '.chart.result[0].meta.regularMarketVolume // empty')

if [[ -z "$PRICE" || -z "$PREV" ]]; then
  echo "$(date -Iseconds) parse failed: $(echo "$JSON" | head -c 200)"
  exit 0
fi

# Compute change & %
DIFF=$(awk -v p="$PRICE" -v c="$PREV" 'BEGIN{printf "%.2f", p-c}')
PCT=$(awk  -v p="$PRICE" -v c="$PREV" 'BEGIN{printf "%+.2f", ((p-c)/c)*100}')
SIGN=$(awk -v d="$DIFF" 'BEGIN{ if(d+0>=0) print "🟢"; else print "🔴" }')
DIFF_DISP=$(awk -v d="$DIFF" 'BEGIN{ if(d+0>=0) printf "+%.2f", d; else printf "%.2f", d }')

# Volume in human form
VOL_HUMAN=$(awk -v v="$VOL" 'BEGIN{
  if (v>=1e9) printf "%.2fB", v/1e9;
  else if (v>=1e6) printf "%.1fM", v/1e6;
  else if (v>=1e3) printf "%.0fK", v/1e3;
  else printf "%d", v
}')

MSG="${SIGN} NVDA \$${PRICE}  ${DIFF_DISP} (${PCT}%)  · day ${LOW}–${HIGH}  · vol ${VOL_HUMAN}"

# Send via proactive trigger → routed to telegram target
curl -fsS --max-time 10 \
  -X POST "http://127.0.0.1:${PORT}/api/proactive/trigger" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg src "cron:nvda-report" --arg msg "$MSG" --arg tgt "$TARGET" \
    '{source:$src, message:$msg, mode:"notify", target:$tgt}')" \
  >/dev/null || echo "$(date -Iseconds) send failed"

echo "$(date -Iseconds) sent: $MSG"
