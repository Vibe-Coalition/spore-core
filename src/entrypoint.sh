#!/bin/sh
# Entrypoint: fixes bind-mount ownership, seeds agent-owned directories,
# ensures a persistent Python venv, generates an env manifest, then starts
# node as the unprivileged spore user (UID/GID 2000).
#
# The container starts as root so we can chown bind-mounted volumes, then
# drops to spore (2000:2000) via setpriv before exec-ing node.

TOOLS_SRC="/app/tools-default"
TOOLS_DEST="/app/tools"
VENV_PATH="/workspace/.venv"
MANIFEST="/workspace/.env-manifest.json"
CRONTAB_PERSIST_DIR="/workspace/.crontabs"

# ── Fixed spore identity ─────────────────────────────────────────────
# All spore containers run as UID/GID 2000 (spore:spore).
# Host admins (ubuntu, connor) access files via group membership.
SPORE_UID=2000
SPORE_GID=2000

# ── Fix bind-mount ownership ────────────────────────────────────────
# Smart chown: if the top of the directory is already owned by spore,
# skip the recursive walk (huge win on /workspace which can hold tens
# of thousands of cached files on a slow bind-mount filesystem). Set
# SPORE_FORCE_CHOWN=true to override and always do the full walk.
chown_smart() {
  local target="$1"
  [ -e "$target" ] || return 0
  if [ "${SPORE_FORCE_CHOWN:-false}" != "true" ]; then
    local cur="$(stat -c '%u:%g' "$target" 2>/dev/null)"
    if [ "$cur" = "$SPORE_UID:$SPORE_GID" ]; then
      return 0
    fi
  fi
  chown -R "$SPORE_UID:$SPORE_GID" "$target" 2>/dev/null || true
}
chown_smart /data
chown_smart /workspace
chown_smart /app/tools
chown_smart /app/plugins
# Group-write so the manager container (UID 1000, GID 2000 supplementary) can
# update .env and spore.json through the shared bind mount. Cheap on /data
# (~100 files); never run on /workspace since cache files don't need it.
chmod -R g+rw /data 2>/dev/null || true

# ── Shared volumes — group-writable for all spore instances ────────
if [ -d /shared/skills ]; then
  chgrp -R "$SPORE_GID" /shared/skills 2>/dev/null || true
  chmod 2775 /shared/skills 2>/dev/null || true
  chmod g+rw /shared/skills/* 2>/dev/null || true
fi

mkdir -p "$CRONTAB_PERSIST_DIR" /home/spore 2>/dev/null || true
chown -R "$SPORE_UID:$SPORE_GID" "$CRONTAB_PERSIST_DIR" /home/spore 2>/dev/null || true
chmod 700 "$CRONTAB_PERSIST_DIR" /home/spore 2>/dev/null || true
export CRONTAB_PERSIST_DIR
export HOME="/home/spore"

# Seed /app/tools from image snapshot if the volume is empty
if [ -d "$TOOLS_SRC" ] && [ -z "$(ls -A $TOOLS_DEST 2>/dev/null)" ]; then
  echo "[entrypoint] seeding /app/tools from image defaults"
  cp -r "$TOOLS_SRC/." "$TOOLS_DEST/"
  chown -R "$SPORE_UID:$SPORE_GID" "$TOOLS_DEST" 2>/dev/null || true
fi

# Create persistent Python venv on the workspace volume if it doesn't exist.
# Uses --system-site-packages so apt-installed libs (numpy, PIL, opencv) are available.
if [ ! -f "$VENV_PATH/bin/python3" ]; then
  echo "[entrypoint] creating persistent Python venv at $VENV_PATH"
  python3 -m venv --system-site-packages "$VENV_PATH"
fi

# ── Boot-time splash on the agent's web port ────────────────────────
# Tiny static HTTP server that holds the canvas URL while the rest of
# entrypoint runs and Node spins up. Killed right before exec'ing node
# so the port is free. Splash auto-refreshes every 2s, so the user
# lands on the real /graph as soon as Node binds.
SPORE_WEB_PORT="${SPORE_WEB_PORT:-}"
if [ -z "$SPORE_WEB_PORT" ]; then
  for f in /app/.env /data/.env; do
    [ -f "$f" ] || continue
    val="$(grep -E '^SPORE_WEB_PORT=' "$f" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')"
    if [ -n "$val" ]; then SPORE_WEB_PORT="$val"; break; fi
  done
fi
SPORE_WEB_PORT="${SPORE_WEB_PORT:-18803}"
SPLASH_PID=""
if [ -d /app/static/booting ] && command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$SPORE_WEB_PORT" --bind 0.0.0.0 \
    --directory /app/static/booting > /tmp/splash.log 2>&1 &
  SPLASH_PID=$!
  echo "[entrypoint] booting splash on :$SPORE_WEB_PORT (pid=$SPLASH_PID)"
fi

# Generate environment manifest so the agent knows what's installed without probing.
# Cached for 1 hour — packages rarely change boot-to-boot, and the
# pip-list + 7 cmd-version subprocesses cost ~10s on a slow filesystem.
# Set SPORE_FORCE_MANIFEST=true to regenerate on demand.
MANIFEST_TTL=3600
SKIP_MANIFEST=""
if [ -f "$MANIFEST" ] && [ "${SPORE_FORCE_MANIFEST:-false}" != "true" ]; then
  age=$(( $(date +%s) - $(stat -c '%Y' "$MANIFEST" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 0 ] && [ "$age" -lt "$MANIFEST_TTL" ]; then
    SKIP_MANIFEST=1
  fi
fi
if [ -n "$SKIP_MANIFEST" ]; then
  echo "[entrypoint] env manifest cached (age=${age}s, ttl=${MANIFEST_TTL}s)"
else
python3 -c "
import json, sys, subprocess, os

manifest = {
    'generated': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'python': f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}',
    'python_packages': {},
    'system_tools': {},
    'venv': '$VENV_PATH',
}

# Collect Python packages (system + venv)
try:
    pip_out = subprocess.check_output(
        ['$VENV_PATH/bin/pip', 'list', '--format=json'],
        stderr=subprocess.DEVNULL, timeout=15
    ).decode()
    for pkg in json.loads(pip_out):
        manifest['python_packages'][pkg['name'].lower()] = pkg['version']
except Exception:
    pass

# Detect system tools
for cmd, flag in [
    ('ffmpeg', '-version'), ('git', '--version'), ('sqlite3', '--version'),
    ('curl', '--version'), ('convert', '-version'), ('jq', '--version'),
    ('node', '--version'),
]:
    try:
        out = subprocess.check_output(
            [cmd, flag], stderr=subprocess.STDOUT, timeout=5
        ).decode().split(chr(10))[0].strip()
        manifest['system_tools'][cmd] = out
    except Exception:
        pass

with open('$MANIFEST', 'w') as f:
    json.dump(manifest, f, indent=2)
" 2>/dev/null && echo "[entrypoint] environment manifest written" || echo "[entrypoint] manifest generation failed (non-fatal)"
fi  # SKIP_MANIFEST guard

# ── Persist ALL caches and local installs to workspace volume ───────
# Everything outside /workspace and /data is ephemeral container layer.
# Redirect home dirs, caches, and language-specific install paths so
# nothing needs to be reinstalled after a rebuild/recreate.
PERSIST="/workspace/.local"
CACHE="/workspace/.cache"
mkdir -p "$PERSIST/bin" "$PERSIST/lib" "$PERSIST/share" \
         "$CACHE/pip" "$CACHE/npm" "$CACHE/huggingface" \
         "$PERSIST/npm-global/lib" \
         "$PERSIST/go/bin" "$PERSIST/cargo/bin" \
         "$PERSIST/gem" "$PERSIST/rustup" 2>/dev/null || true

# XDG base dirs — covers most well-behaved Linux tools
export XDG_CACHE_HOME="$CACHE"
export XDG_DATA_HOME="$PERSIST/share"
export XDG_CONFIG_HOME="$PERSIST/config"

# Python
export PIP_CACHE_DIR="$CACHE/pip"
export PIPX_HOME="$PERSIST/pipx"
export PIPX_BIN_DIR="$PERSIST/bin"

# Node / npm
export npm_config_cache="$CACHE/npm"
export npm_config_prefix="$PERSIST/npm-global"
export NODE_PATH="$PERSIST/npm-global/lib/node_modules"

# Browser automation — Chromium is pre-installed at /opt/pw-browsers during image build
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PUPPETEER_CACHE_DIR="$CACHE/puppeteer"
export CHROME_USER_DATA_DIR="$CACHE/chrome-data"

# Go
export GOPATH="$PERSIST/go"
export GOMODCACHE="$CACHE/go-mod"

# Rust / Cargo
export CARGO_HOME="$PERSIST/cargo"
export RUSTUP_HOME="$PERSIST/rustup"

# Ruby
export GEM_HOME="$PERSIST/gem"
export BUNDLE_PATH="$PERSIST/gem"

# Hugging Face / ML
export HF_HOME="$CACHE/huggingface"
export TRANSFORMERS_CACHE="$CACHE/huggingface/transformers"
export TORCH_HOME="$CACHE/torch"

# General
export HOME_PERSIST="$PERSIST"

# Add persistent bin dirs to PATH so installed CLIs are found after restart
export PATH="$PERSIST/bin:$PERSIST/npm-global/bin:$PERSIST/go/bin:$PERSIST/cargo/bin:$PERSIST/gem/bin:$PATH"

# ── Auto-reinstall apt packages from previous runs ─────────────────
# Agents can apt-install packages; we record them to a manifest and
# replay on boot so they survive rebuilds. Runs in background to not
# delay startup.
APT_MANIFEST="/workspace/.apt-packages"
if [ -f "$APT_MANIFEST" ] && [ -s "$APT_MANIFEST" ]; then
  echo "[entrypoint] reinstalling persisted apt packages in background..."
  (apt-get update -qq && xargs -a "$APT_MANIFEST" apt-get install -y -qq --no-install-recommends > /dev/null 2>&1 && echo "[entrypoint] apt packages restored") &
fi

# ── Restore persisted crontabs and start cron ──────────────────────
if [ "${SPORE_ENABLE_CRON:-true}" != "false" ] && command -v /usr/bin/crontab >/dev/null 2>&1; then
  for file in "$CRONTAB_PERSIST_DIR"/*; do
    [ -f "$file" ] || continue
    user="$(basename "$file")"
    if id "$user" >/dev/null 2>&1; then
      chmod 600 "$file" 2>/dev/null || true
      /usr/bin/crontab -u "$user" "$file" >/dev/null 2>&1 \
        && echo "[entrypoint] restored crontab for $user" \
        || echo "[entrypoint] failed to restore crontab for $user"
    fi
  done

  if command -v cron >/dev/null 2>&1; then
    rm -f /var/run/crond.pid /var/run/cron.pid 2>/dev/null || true
    cron >/dev/null 2>&1 \
      && echo "[entrypoint] cron daemon started" \
      || echo "[entrypoint] cron daemon failed to start (non-fatal)"
  fi
fi

# ── Tailscale daemon (userspace mode) ──────────────────────────────
# Start tailscaled in the background so the container can reach private
# tailnets. Userspace mode avoids needing NET_ADMIN / /dev/net/tun.
# State persists to /data/tailscale so login survives restart.
# Actual `tailscale up` (SSO login) is triggered from the web settings
# panel — we only start the daemon here.
if [ "${SPORE_TAILSCALE_ENABLED:-false}" = "true" ] || [ -d /data/tailscale ]; then
  TS_DIR="/data/tailscale"
  mkdir -p "$TS_DIR"
  chown "$SPORE_UID:$SPORE_GID" "$TS_DIR" 2>/dev/null || true
  if command -v tailscaled >/dev/null 2>&1; then
    if ! pgrep -x tailscaled >/dev/null 2>&1; then
      echo "[entrypoint] starting tailscaled (userspace-networking)"
      # Socket owned by spore so the agent can run `tailscale` without sudo.
      # SOCKS5 + HTTP proxy exposed on localhost for any tooling that wants
      # to tunnel through the tailnet.
      tailscaled \
        --tun=userspace-networking \
        --state="$TS_DIR/state" \
        --socket="$TS_DIR/ts.sock" \
        --socks5-server=localhost:1055 \
        --outbound-http-proxy-listen=localhost:1055 \
        > "$TS_DIR/tailscaled.log" 2>&1 &
      # Give the socket a moment, then chown so spore can talk to it
      for i in 1 2 3 4 5; do
        [ -S "$TS_DIR/ts.sock" ] && break
        sleep 0.4
      done
      chown "$SPORE_UID:$SPORE_GID" "$TS_DIR/ts.sock" 2>/dev/null || true
      chmod 660 "$TS_DIR/ts.sock" 2>/dev/null || true
      # Persist operator=spore so the spore user can run `tailscale up`
      # (which triggers SSO login) without sudo. This only has to happen
      # once per daemon lifetime; repeated calls are idempotent.
      for i in 1 2 3 4 5; do
        if tailscale --socket "$TS_DIR/ts.sock" set --operator=spore 2>/dev/null; then
          echo "[entrypoint] tailscale operator set to spore"
          break
        fi
        sleep 0.4
      done
    fi
  else
    echo "[entrypoint] tailscaled not installed — skipping"
  fi
fi

# ── User on-boot script ──────────────────────────────────────────────
# Agents can create /workspace/.on-boot.sh to start custom servers,
# daemons, or other processes that should survive container restarts.
ON_BOOT="/workspace/.on-boot.sh"
if [ -f "$ON_BOOT" ] && [ -s "$ON_BOOT" ]; then
  echo "[entrypoint] running user on-boot script in background..."
  (setpriv --reuid="$SPORE_UID" --regid="$SPORE_GID" --init-groups sh "$ON_BOOT" > /workspace/.on-boot.log 2>&1 && echo "[entrypoint] on-boot script finished") &
fi

# Final ownership pass — catches files created by the setup steps
# above (manifest, .venv, /app/tools seed). Narrow targets only — a
# full /workspace walk is what made cold boot 45s+. Smart top-of-tree
# chown above already handled the bulk; this just sweeps the few new
# files.
chown "$SPORE_UID:$SPORE_GID" "$MANIFEST" 2>/dev/null || true
[ -d "$VENV_PATH" ] && chown -R "$SPORE_UID:$SPORE_GID" "$VENV_PATH" 2>/dev/null || true

# Kill the boot-splash server so its port is free. Brief gap (<1s)
# until Node binds; the splash's 2s auto-refresh covers it.
if [ -n "${SPLASH_PID:-}" ]; then
  kill "$SPLASH_PID" 2>/dev/null
  wait "$SPLASH_PID" 2>/dev/null
  echo "[entrypoint] splash stopped — handing off to node"
fi

# Run the node process — always drop to unprivileged spore user (2000:2000).
# Package installation is handled via restricted sudo (apt-get/apt/dpkg only).
umask 0002
exec setpriv --reuid="$SPORE_UID" --regid="$SPORE_GID" --init-groups node index.js
