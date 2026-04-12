#!/bin/sh
# Entrypoint: fixes bind-mount ownership, seeds agent-owned directories,
# ensures a persistent Python venv, generates an env manifest, then starts
# node as the unprivileged anima user (UID/GID 2000).
#
# The container starts as root so we can chown bind-mounted volumes, then
# drops to anima (2000:2000) via setpriv before exec-ing node.

TOOLS_SRC="/app/tools-default"
TOOLS_DEST="/app/tools"
VENV_PATH="/workspace/.venv"
MANIFEST="/workspace/.env-manifest.json"

# ── Fixed anima identity ─────────────────────────────────────────────
# All anima containers run as UID/GID 2000 (anima:anima).
# Host admins (ubuntu, connor) access files via group membership.
ANIMA_UID=2000
ANIMA_GID=2000

# ── Fix bind-mount ownership ────────────────────────────────────────
chown -R "$ANIMA_UID:$ANIMA_GID" /data /workspace /app/tools 2>/dev/null || true
chown -R "$ANIMA_UID:$ANIMA_GID" /app/plugins 2>/dev/null || true
# Group-write so the manager container (UID 1000, GID 2000 supplementary) can
# update .env and anima.json through the shared bind mount
chmod -R g+rw /data 2>/dev/null || true

# ── Shared volumes — group-writable for all anima instances ────────
if [ -d /shared/skills ]; then
  chgrp -R "$ANIMA_GID" /shared/skills 2>/dev/null || true
  chmod 2775 /shared/skills 2>/dev/null || true
  chmod g+rw /shared/skills/* 2>/dev/null || true
fi

# Seed /app/tools from image snapshot if the volume is empty
if [ -d "$TOOLS_SRC" ] && [ -z "$(ls -A $TOOLS_DEST 2>/dev/null)" ]; then
  echo "[entrypoint] seeding /app/tools from image defaults"
  cp -r "$TOOLS_SRC/." "$TOOLS_DEST/"
  chown -R "$ANIMA_UID:$ANIMA_GID" "$TOOLS_DEST" 2>/dev/null || true
fi

# Create persistent Python venv on the workspace volume if it doesn't exist.
# Uses --system-site-packages so apt-installed libs (numpy, PIL, opencv) are available.
if [ ! -f "$VENV_PATH/bin/python3" ]; then
  echo "[entrypoint] creating persistent Python venv at $VENV_PATH"
  python3 -m venv --system-site-packages "$VENV_PATH"
fi

# Generate environment manifest so the agent knows what's installed without probing.
# Refreshed every boot to stay current with image/venv changes.
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

# ── User on-boot script ──────────────────────────────────────────────
# Agents can create /workspace/.on-boot.sh to start custom servers,
# daemons, or other processes that should survive container restarts.
ON_BOOT="/workspace/.on-boot.sh"
if [ -f "$ON_BOOT" ] && [ -s "$ON_BOOT" ]; then
  echo "[entrypoint] running user on-boot script in background..."
  (setpriv --reuid="$ANIMA_UID" --regid="$ANIMA_GID" --init-groups sh "$ON_BOOT" > /workspace/.on-boot.log 2>&1 && echo "[entrypoint] on-boot script finished") &
fi

# Final ownership pass — catches files created by the setup steps above
chown -R "$ANIMA_UID:$ANIMA_GID" /data /workspace 2>/dev/null || true

# Run the node process — always drop to unprivileged anima user (2000:2000).
# Package installation is handled via restricted sudo (apt-get/apt/dpkg only).
umask 0002
exec setpriv --reuid="$ANIMA_UID" --regid="$ANIMA_GID" --init-groups node index.js
