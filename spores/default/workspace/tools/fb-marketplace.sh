#!/bin/bash
# Facebook Marketplace CLI
cd /workspace/skills/fb-marketplace/scripts
export PYTHONPATH=/workspace/pylibs

case "$1" in
  search|set-cookies)
    python3 fbm.py "$@"
    ;;
  watch|learn|scan)
    python3 monitor.py "$@"
    ;;
  inbox|send|threads)
    python3 fb_chat.py "$@"
    ;;
  login)
    python3 fb_login.py "${@:2}"
    ;;
  *)
    echo "Usage: fb-marketplace <search|watch|learn|scan|inbox|send|login|set-cookies> [args]"
    ;;
esac