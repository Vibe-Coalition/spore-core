#!/usr/bin/env bash
# Fetches NVDA market data and asks the agent (via /api/proactive/trigger, mode=agent)
# to analyze it and post a buy/hold/avoid call to telegram:697706930.
set -euo pipefail

PORT="${SPORE_WEB_PORT:-18803}"
TARGET="telegram:697706930"

# Pull last ~6h of 5m candles so the agent has context for indicators.
RAW="$(curl -fsS \
  'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=5m&range=1d' \
  -H 'User-Agent: Mozilla/5.0' || true)"

if [ -z "$RAW" ]; then
  echo "$(date -Iseconds) fetch failed" >&2
  exit 0
fi

# Compress to a compact JSON snapshot the agent can reason over without blowing token budget.
SNAPSHOT="$(printf '%s' "$RAW" | python3 -c '
import json, sys, statistics
d = json.load(sys.stdin)
r = d["chart"]["result"][0]
m = r["meta"]
q = r["indicators"]["quote"][0]
ts = r["timestamp"]
closes = [c for c in q["close"] if c is not None]
vols = [v for v in q["volume"] if v is not None]
last = closes[-1] if closes else m.get("regularMarketPrice")
prev = m.get("chartPreviousClose") or m.get("previousClose")
chg = (last - prev) if (last and prev) else None
pct = (chg / prev * 100) if (chg is not None and prev) else None
day_low = m.get("regularMarketDayLow")
day_high = m.get("regularMarketDayHigh")
vol = m.get("regularMarketVolume")
# Recent closes for trend (last 12 = 1h on 5m bars)
recent = closes[-12:] if len(closes) >= 12 else closes
ma20 = statistics.mean(closes[-20:]) if len(closes) >= 20 else None
ma50 = statistics.mean(closes[-50:]) if len(closes) >= 50 else None
# Simple RSI(14) on closes
def rsi(vals, n=14):
    if len(vals) < n+1: return None
    gains=[]; losses=[]
    for i in range(1, len(vals)):
        d = vals[i]-vals[i-1]
        gains.append(max(d,0)); losses.append(max(-d,0))
    avg_g = sum(gains[-n:])/n
    avg_l = sum(losses[-n:])/n
    if avg_l == 0: return 100.0
    rs = avg_g/avg_l
    return 100 - (100/(1+rs))
rsi14 = rsi(closes)
out = {
  "symbol": "NVDA",
  "last": round(last,2) if last else None,
  "prev_close": round(prev,2) if prev else None,
  "change": round(chg,2) if chg is not None else None,
  "pct": round(pct,2) if pct is not None else None,
  "day_low": day_low, "day_high": day_high,
  "volume": vol,
  "ma20_5m": round(ma20,2) if ma20 else None,
  "ma50_5m": round(ma50,2) if ma50 else None,
  "rsi14_5m": round(rsi14,1) if rsi14 else None,
  "recent_closes": [round(c,2) for c in recent],
  "market_state": m.get("marketState"),
}
print(json.dumps(out))
')"

if [ -z "$SNAPSHOT" ]; then
  echo "$(date -Iseconds) snapshot empty" >&2
  exit 0
fi

PROMPT="NVDA 5-minute auto-analysis tick. Snapshot: ${SNAPSHOT}

Look at the price vs MAs, RSI, and recent close trend. Send ONE short message to ${TARGET} via message_send (target=\"${TARGET}\") in this exact shape:

NVDA \$<price> <±%> | RSI <n>, vs MA20 <±%> | <BUY|HOLD|AVOID> — <one-line reason>
(not advice, 5-min noise)

Be decisive but honest about ambiguity. Do not call any other tools. Do not store anything in the graph. Just send the one message."

# POST to local proactive trigger so it runs as an agent turn.
curl -fsS -X POST "http://127.0.0.1:${PORT}/api/proactive/trigger" \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg src 'cron:nvda-analysis' --arg msg "$PROMPT" --arg ch "$TARGET" \
    '{source:$src, message:$msg, mode:"agent", channelId:$ch}')" \
  > /dev/null
echo "$(date -Iseconds) triggered"
