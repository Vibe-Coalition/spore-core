#!/bin/bash
# Facebook Marketplace CLI
# Usage: fb-marketplace search "coffee table" --radius 25 --max 500
#        fb-marketplace watch add "ps5" --max 400
#        fb-marketplace watch list
#        fb-marketplace inbox
#        fb-marketplace set-cookies '<cookie string>'

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
    echo "  search 'query' [--radius N] [--min N] [--max N] [--days N] [--sort price_asc]"
    echo "  watch add 'query' [--max N] [--radius N]"
    echo "  watch list|remove|update <id>"
    echo "  scan [watch_id]  -- check for new deals"
    echo "  learn <watch_id> 'preference text'"
    echo "  inbox  -- view Messenger inbox"
    echo "  send <user_id> 'message'"
    echo "  login [--check|--set-creds EMAIL PASS]"
    ;;
esac