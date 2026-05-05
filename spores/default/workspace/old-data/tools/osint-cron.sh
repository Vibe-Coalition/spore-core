#!/bin/bash
# Run OSINT monitor and send report to Telegram if there's news
cd /workspace/tools
OUTPUT=$(/workspace/.venv/bin/python3 /workspace/tools/osint-monitor.py 2>/dev/null)

if [ -z "$OUTPUT" ] || [ "$OUTPUT" = "NO_NEW_ITEMS" ]; then
    exit 0
fi

# Write report to a marker file so Anima can pick it up
echo "$OUTPUT" > /tmp/osint_pending_report.txt
echo "REPORT_READY"