#!/usr/bin/env python3
"""FB Marketplace scanner — sends new listings to Telegram via Anima API."""
import subprocess, sys, time, os

sys.path.insert(0, '/workspace/pylibs')

TELEGRAM_TARGET = "telegram:697706930"
SCAN_INTERVAL = 1800  # 30 minutes
SCRIPTS_DIR = "/workspace/skills/fb-marketplace/scripts"

def run_scan():
    """Run monitor.py check and return output."""
    env = os.environ.copy()
    env["PYTHONPATH"] = "/workspace/pylibs"
    result = subprocess.run(
        [sys.executable, "monitor.py", "check"],
        cwd=SCRIPTS_DIR, capture_output=True, text=True, env=env, timeout=60
    )
    return result.stdout + result.stderr

def send_telegram(message):
    """Send message via Anima's message_send tool by writing to a trigger file."""
    # We'll use the Anima API — but since we're in a script, we'll just print
    # and let a wrapper handle it. For now, write to a notification queue.
    queue_dir = "/workspace/fbm_notifications"
    os.makedirs(queue_dir, exist_ok=True)
    ts = int(time.time())
    path = os.path.join(queue_dir, f"msg_{ts}.txt")
    with open(path, "w") as f:
        f.write(f"TARGET:{TELEGRAM_TARGET}\n{message}")
    return path

def main():
    print("🔍 FB Marketplace Telegram notifier started")
    while True:
        try:
            output = run_scan().strip()
            print(f"[scan] {output[:200]}")

            if "COOKIES_EXPIRED" in output or "401" in output:
                send_telegram("⚠️ FB Marketplace cookies expired — re-login needed")
            elif "0 new" not in output and "No new" not in output and "No active" not in output:
                # There are new listings
                send_telegram(f"🛒 New FB Marketplace listings:\n\n{output}")
            else:
                print("[scan] No new listings")
        except Exception as e:
            print(f"[error] {e}")
            send_telegram(f"⚠️ FB Marketplace scanner error: {e}")

        print(f"[sleep] Next scan in {SCAN_INTERVAL}s")
        time.sleep(SCAN_INTERVAL)

if __name__ == "__main__":
    main()