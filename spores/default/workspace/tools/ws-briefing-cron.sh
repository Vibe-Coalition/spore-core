#!/bin/bash
# Wealthsimple briefing wrapper — loads bot token and runs briefing
export TELEGRAM_BOT_TOKEN=$(cat /tmp/ws_bot_token)
/workspace/.venv/bin/python3 /workspace/tools/ws-briefing.py "$1"
