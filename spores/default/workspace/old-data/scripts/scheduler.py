#!/usr/bin/env python3
"""
Wealthsimple Market Report Scheduler
Sends market open (9:30 AM ET) and close (4:00 PM ET) reports to Telegram.
Runs as a background daemon.
"""
import subprocess, os, sys, time, logging, requests
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

PYTHON = "/workspace/.venv/bin/python3"
REPORT_SCRIPT = "/workspace/scripts/market_report.py"
CHAT_ID = "697706930"
LOG_FILE = "/workspace/logs/scheduler.log"
TOKEN_FILE = "/workspace/.telegram_token"
ET = ZoneInfo("US/Eastern")

logging.basicConfig(
    filename=LOG_FILE, level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("scheduler")

# Scheduled times (hour, minute) in ET
SCHEDULE = {
    "open":  (9, 30),
    "close": (16, 0),
}

WEEKDAYS = {0, 1, 2, 3, 4}  # Mon-Fri


def get_token():
    # Try env var first, then token file
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if token:
        return token
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    return ""


def send_telegram(text: str, token: str):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    chunks = []
    while len(text) > 4000:
        split_at = text.rfind("\n", 0, 4000)
        if split_at == -1:
            split_at = 4000
        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    chunks.append(text)
    
    for chunk in chunks:
        r = requests.post(url, json={
            "chat_id": CHAT_ID, 
            "text": chunk, 
            "parse_mode": "Markdown"
        }, timeout=30)
        if not r.json().get("ok"):
            log.error(f"Telegram send failed: {r.text}")


def generate_report(report_type: str) -> str:
    result = subprocess.run(
        [PYTHON, REPORT_SCRIPT, report_type],
        capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        log.error(f"Report generation failed: {result.stderr}")
        return f"⚠️ Failed to generate {report_type} report"
    return result.stdout.strip()


def is_market_day(now_et):
    return now_et.weekday() in WEEKDAYS


def should_send(report_type: str, now_et) -> bool:
    h, m = SCHEDULE[report_type]
    scheduled_minutes = h * 60 + m
    current_minutes = now_et.hour * 60 + now_et.minute
    return abs(current_minutes - scheduled_minutes) <= 1


def run_loop():
    token = get_token()
    if not token:
        log.error("No Telegram token found!")
        sys.exit(1)
    
    log.info("Scheduler started")
    sent_today = set()
    last_date = None
    
    while True:
        now = datetime.now(timezone.utc)
        now_et = now.astimezone(ET)
        
        today = now_et.date()
        if last_date != today:
            sent_today.clear()
            last_date = today
            log.info(f"New day: {today} (weekday={now_et.strftime('%A')})")
        
        if is_market_day(now_et):
            for report_type in SCHEDULE:
                if report_type not in sent_today and should_send(report_type, now_et):
                    log.info(f"Generating {report_type} report")
                    report = generate_report(report_type)
                    send_telegram(report, token)
                    sent_today.add(report_type)
                    log.info(f"{report_type} report sent")
        
        time.sleep(30)


if __name__ == "__main__":
    try:
        run_loop()
    except KeyboardInterrupt:
        log.info("Scheduler stopped")
    except Exception as e:
        log.error(f"Scheduler crashed: {e}")
        raise