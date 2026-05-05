#!/bin/sh
# Wrapper to launch the scheduler with the Telegram bot token
export TELEGRAM_BOT_TOKEN=$(cat /tmp/.env-TELEGRAM_BOT_TOKEN-1775985550539)
exec /workspace/.venv/bin/python3 /workspace/scripts/scheduler.py