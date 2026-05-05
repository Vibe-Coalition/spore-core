#!/usr/bin/env python3
"""
FB Marketplace Telegram Notifier
Runs periodic scans and writes results to a file for the agent to send via Telegram.
Designed to be called from a background task.
"""

import subprocess, time, sys, os, json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
POLL_INTERVAL = int(os.environ.get("FBM_POLL_MINUTES", "30")) * 60
NOTIFY_FILE = Path(os.environ.get("FBM_NOTIFY_FILE", "/tmp/fbm_notifications.jsonl"))
TELEGRAM_CHAT = os.environ.get("FBM_TELEGRAM_CHAT", "697706930")

def run_scan():
    """Run a scan and return new listings text."""
    env = os.environ.copy()
    env["PYTHONPATH"] = "/workspace/pylibs"
    result = subprocess.run(
        ["python3", str(SCRIPT_DIR / "monitor.py"), "check"],
        capture_output=True, text=True, env=env, timeout=120
    )
    return result.stdout.strip(), result.returncode

def write_notification(text):
    """Append notification to JSONL file for agent pickup."""
    import datetime
    entry = {
        "timestamp": datetime.datetime.now().isoformat(),
        "chat_id": TELEGRAM_CHAT,
        "text": text
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")

def main():
    print(f"🔍 FBM Notifier started — scanning every {POLL_INTERVAL//60}min, sending to Telegram {TELEGRAM_CHAT}")
    print(f"   Notify file: {NOTIFY_FILE}")
    
    while True:
        try:
            output, rc = run_scan()
            
            if not output or "No new listings" in output or "0 new" in output:
                print(f"[{time.strftime('%H:%M')}] No new listings")
            else:
                print(f"[{time.strftime('%H:%M')}] New listings found!")
                write_notification(output)
                
        except Exception as e:
            print(f"[{time.strftime('%H:%M')}] Error: {e}")
        
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()