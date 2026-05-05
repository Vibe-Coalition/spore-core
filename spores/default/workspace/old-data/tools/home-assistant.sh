#!/bin/bash
# Home Assistant skill wrapper
export HA_URL="${HA_URL:-https://ha.hyrule.vip}"
/workspace/.venv/bin/python3 /workspace/skills/home-assistant/scripts/ha.py "$@"