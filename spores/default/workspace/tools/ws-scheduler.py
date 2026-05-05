#!/usr/bin/env python3
"""
Wealthsimple Briefing Scheduler — runs morning/evening briefings automatically.
Morning: 8:00 AM | Evening: 8:00 PM (system UTC, adjust offset as needed)
"""
import subprocess
import time
import os
from datetime import datetime

PYTHON = "/workspace/.venv/bin/python3"
SCRIPT = "/workspace/tools/ws-briefing.py"
SCHEDULE = {
    (13, 30): "morning",   # 9:30 AM ET — market open
    (20, 0): "evening",    # 4:00 PM ET — market close
}

def run_briefing(btype):
    env = os.environ.copy()
    # Read token from file
    try:
        with open("/tmp/ws_bot_token") as f:
            env["TELEGRAM_BOT_TOKEN"] = f.read().strip()
    except:
        print("ERROR: No bot token file at /tmp/ws_bot_token")
        return
    result = subprocess.run(
        [PYTHON, SCRIPT, btype],
        env=env, capture_output=True, text=True, timeout=60
    )
    print(f"[{datetime.now()}] {btype} briefing: {result.stdout.strip()}")
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip()}")

def main():
    last_run = {}
    print(f"WS Briefing Scheduler started. Morning=8AM, Evening=8PM")
    while True:
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        key = (now.hour, now.minute)
        
        if key in SCHEDULE and last_run.get(key) != today:
            btype = SCHEDULE[key]
            print(f"[{now}] Running {btype} briefing...")
            run_briefing(btype)
            last_run[key] = today
        
        time.sleep(60)  # Check every minute

if __name__ == "__main__":
    main()
