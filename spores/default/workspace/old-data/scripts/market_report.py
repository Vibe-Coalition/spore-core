#!/usr/bin/env python3
"""
Market report generator for Wealthsimple.
Sends daily report to Telegram at market open (9:30 AM ET) and close (4:00 PM ET).
Uses Anima's own API to send messages via Telegram.
"""
import sys
import os
import json
import subprocess
from datetime import datetime, timezone, timedelta

# Paths
WS_SCRIPT = "/workspace/skills/wealthsimple/scripts/ws.py"
PYTHON = "/workspace/.venv/bin/python3"
ET = timezone(timedelta(hours=-4))  # Eastern Time (EDT)

def run_ws(command):
    """Run a Wealthsimple script command and return output."""
    try:
        result = subprocess.run(
            [PYTHON, WS_SCRIPT, command],
            capture_output=True, text=True, timeout=30,
            cwd="/workspace/skills/wealthsimple/scripts"
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception as e:
        return None

def get_balances():
    return run_ws("balances")

def get_holdings():
    return run_ws("holdings")

def get_history():
    return run_ws("history")

def get_accounts():
    return run_ws("accounts")

def is_market_open():
    """Check if US markets are open (Mon-Fri, 9:30 AM - 4:00 PM ET)."""
    now_et = datetime.now(ET)
    weekday = now_et.weekday()
    if weekday >= 5:  # Saturday/Sunday
        return False
    market_open = now_et.replace(hour=9, minute=30, second=0, microsecond=0)
    market_close = now_et.replace(hour=16, minute=0, second=0, microsecond=0)
    return market_open <= now_et <= market_close

def build_report(period="open"):
    """Build the market report. period = 'open' or 'close'."""
    now_et = datetime.now(ET)
    emoji = "🌅" if period == "open" else "🌇"
    header = f"{emoji} **Market {period.capitalize()} Report** — {now_et.strftime('%A, %B %d, %Y')}"
    
    # Gather data
    balances = get_balances()
    holdings = get_holdings()
    history = get_history()
    
    sections = [header, ""]
    
    if balances:
        sections.append("📊 **Balances**")
        sections.append("```")
        sections.append(balances)
        sections.append("```")
    else:
        sections.append("⚠️ Could not fetch balances — session may have expired.")
    
    sections.append("")
    
    if holdings:
        sections.append("📈 **Holdings**")
        sections.append("```")
        sections.append(holdings)
        sections.append("```")
    else:
        sections.append("⚠️ Could not fetch holdings.")
    
    sections.append("")
    
    if history:
        # Get last 3 data points for trend
        lines = history.strip().split('\n')
        recent = lines[-3:] if len(lines) >= 3 else lines
        sections.append("📉 **Recent Performance**")
        sections.append("```")
        sections.append('\n'.join(recent))
        sections.append("```")
    else:
        sections.append("⚠️ Could not fetch performance history.")
    
    # Market status note
    sections.append("")
    if not is_market_open():
        sections.append("🔒 US markets are currently **closed**.")
    
    return '\n'.join(sections)

if __name__ == "__main__":
    period = sys.argv[1] if len(sys.argv) > 1 else "open"
    report = build_report(period)
    print(report)