#!/usr/bin/env python3
"""
Wealthsimple Daily Briefing — sends morning/evening report via Telegram Bot API.
Called by cron.
"""
import subprocess
import sys
import json
import os
import urllib.request
import urllib.parse
from datetime import datetime

WS_SCRIPT = "/workspace/skills/wealthsimple/scripts/ws.py"
PYTHON = "/workspace/.venv/bin/python3"
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = "697706930"

def run_ws(command):
    result = subprocess.run(
        [PYTHON, WS_SCRIPT, command],
        capture_output=True, text=True, timeout=30
    )
    return result.stdout.strip()

def send_telegram(msg):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": CHAT_ID,
        "text": msg,
        "parse_mode": "Markdown"
    }).encode()
    req = urllib.request.Request(url, data=data)
    resp = urllib.request.urlopen(req, timeout=10)
    result = json.loads(resp.read())
    if not result.get("ok"):
        print(f"Failed to send: {result}")
        sys.exit(1)
    print(f"Sent briefing to Telegram")

def build_morning_briefing():
    now = datetime.now().strftime("%A, %B %d %Y")
    balances = run_ws("balances")
    holdings = run_ws("holdings")
    
    msg = f"""☀️ *Morning Briefing — {now}*

📊 *Balances:*
{balances}

📈 *Holdings:*
{holdings}
"""
    return msg

def build_evening_briefing():
    now = datetime.now().strftime("%A, %B %d %Y")
    balances = run_ws("balances")
    transactions = run_ws("transactions")
    
    msg = f"""🌙 *Evening Briefing — {now}*

📊 *Balances:*
{balances}

💳 *Recent Transactions:*
{transactions}
"""
    return msg

if __name__ == "__main__":
    briefing_type = sys.argv[1] if len(sys.argv) > 1 else "morning"
    
    if briefing_type == "morning":
        msg = build_morning_briefing()
    elif briefing_type == "evening":
        msg = build_evening_briefing()
    else:
        print(f"Unknown briefing type: {briefing_type}")
        sys.exit(1)
    
    send_telegram(msg)
