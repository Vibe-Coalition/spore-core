#!/usr/bin/env python3
"""
OSINT Hourly Scheduler — runs osint-monitor.py every hour,
sends summary to Telegram via Anima message_send.
"""
import subprocess
import time
import json
import os
from datetime import datetime, timezone

MONITOR_SCRIPT = "/workspace/tools/osint-monitor.py"
PYTHON = "/workspace/.venv/bin/python3"
STATE_FILE = "/workspace/tools/osint_scheduler_state.json"
INTERVAL = 3600  # 1 hour

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_run": None, "run_count": 0}

def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

def run_monitor():
    result = subprocess.run(
        [PYTHON, MONITOR_SCRIPT],
        capture_output=True, text=True, timeout=120,
        cwd="/workspace/tools"
    )
    output = result.stdout.strip()
    errors = result.stderr.strip()
    
    if errors:
        print(f"WARN: {errors}")
    
    if not output or output == "NO_NEW_ITEMS":
        return None
    
    return output

def main():
    print(f"OSINT Scheduler started — running every {INTERVAL}s")
    
    while True:
        now = datetime.now(timezone.utc)
        state = load_state()
        
        # Check if enough time has passed
        if state["last_run"]:
            last = datetime.fromisoformat(state["last_run"])
            elapsed = (now - last).total_seconds()
            if elapsed < INTERVAL:
                time.sleep(INTERVAL - elapsed)
                continue
        
        print(f"[{now.isoformat()}] Running OSINT monitor...")
        summary = run_monitor()
        
        state["last_run"] = now.isoformat()
        state["run_count"] = state.get("run_count", 0) + 1
        save_state(state)
        
        if summary:
            # Write summary to a temp file for Anima to pick up and send
            summary_file = "/tmp/osint_latest_report.txt"
            with open(summary_file, "w") as f:
                f.write(summary)
            print(f"New report generated — saved to {summary_file}")
            print(summary[:500])
        else:
            print("No new items this cycle")
        
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()