#!/bin/bash
# Anima startup script — runs on container boot
# Kills stale processes first, then starts fresh

# Kill old scheduler if running
pkill -f ws-scheduler.py 2>/dev/null
sleep 1

# Ensure bot token file exists for the scheduler
if [ ! -f /tmp/ws_bot_token ]; then
    echo "WARNING: /tmp/ws_bot_token missing — WS scheduler will fail"
fi

# Start Wealthsimple briefing scheduler
nohup /workspace/.venv/bin/python3 /workspace/tools/ws-scheduler.py > /tmp/ws-scheduler.log 2>&1 &
echo "WS Scheduler started (PID $!)"

echo "Startup complete."
