#!/bin/sh
set -eu

REAL_CRON="/usr/sbin/cron"
PID_FILE="/var/run/crond.pid"

cron_running() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  [ -d "/proc/$pid" ] || return 1
  cmdline="$(tr '\0' ' ' </proc/$pid/cmdline 2>/dev/null || true)"
  case "$cmdline" in
    *cron*)
      return 0
      ;;
  esac
  return 1
}

main() {
  # Normal "start cron" usage is just `cron` with no args. If the daemon is
  # already up, treat that as success instead of surfacing a pidfile error.
  if [ "$#" -eq 0 ] && cron_running; then
    exit 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    exec "$REAL_CRON" "$@"
  fi

  exec sudo -n "$REAL_CRON" "$@"
}

main "$@"
