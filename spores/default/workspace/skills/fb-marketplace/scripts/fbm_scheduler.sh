#!/bin/bash
# FB Marketplace scanner — sends new listings to Telegram
# Runs every 30 minutes via cron/scheduler

cd /workspace/skills/fb-marketplace/scripts
export PYTHONPATH=/workspace/pylibs

# Scan for new listings, capture output
OUTPUT=$(python3 monitor.py check 2>&1)

# If no new listings, skip
if echo "$OUTPUT" | grep -q "NO_NEW_LISTINGS"; then
    exit 0
fi

# If auth error, notify
if echo "$OUTPUT" | grep -q "COOKIES_EXPIRED"; then
    # Will be sent via message_send by the calling agent
    echo "COOKIES_EXPIRED"
    exit 1
fi

# Output the results for the caller to send
echo "$OUTPUT"