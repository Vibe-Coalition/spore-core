#!/bin/sh
set -eu

REAL_CRONTAB="/usr/bin/crontab"
PERSIST_DIR="${CRONTAB_PERSIST_DIR:-/workspace/.crontabs}"
TARGET_USER=""
EXPLICIT_USER=0
ACTION="replace"

resolve_current_user() {
  if command -v id >/dev/null 2>&1; then
    id -un
    return
  fi
  printf '%s\n' "${USER:-spore}"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -u)
        shift
        [ "$#" -gt 0 ] || break
        TARGET_USER="$1"
        EXPLICIT_USER=1
        ;;
      -l|-h|--help|-V|--version)
        ACTION="read"
        ;;
      -e|-r|-)
        ACTION="mutate"
        ;;
      --)
        shift
        [ "$#" -gt 0 ] && ACTION="mutate"
        break
        ;;
      -*)
        ;;
      *)
        ACTION="mutate"
        ;;
    esac
    shift
  done

  if [ -z "$TARGET_USER" ]; then
    TARGET_USER="$(resolve_current_user)"
  fi
}

real_list() {
  if [ "$EXPLICIT_USER" -eq 1 ]; then
    "$REAL_CRONTAB" -u "$TARGET_USER" -l
    return
  fi
  "$REAL_CRONTAB" -l
}

real_install() {
  file="$1"
  if [ "$EXPLICIT_USER" -eq 1 ]; then
    "$REAL_CRONTAB" -u "$TARGET_USER" "$file"
    return
  fi
  "$REAL_CRONTAB" "$file"
}

restore_if_needed() {
  file="$PERSIST_DIR/$TARGET_USER"
  [ -f "$file" ] || return 0
  if real_list >/dev/null 2>&1; then
    return 0
  fi
  real_install "$file" >/dev/null 2>&1 || true
}

persist_current() {
  mkdir -p "$PERSIST_DIR"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  if real_list >"$tmp" 2>/dev/null; then
    install -m 600 "$tmp" "$PERSIST_DIR/$TARGET_USER"
  else
    rm -f "$PERSIST_DIR/$TARGET_USER"
  fi
  rm -f "$tmp"
  trap - EXIT HUP INT TERM
}

main() {
  parse_args "$@"
  restore_if_needed

  if "$REAL_CRONTAB" "$@"; then
    if [ "$ACTION" = "mutate" ]; then
      persist_current
    fi
    exit 0
  fi

  exit $?
}

main "$@"
