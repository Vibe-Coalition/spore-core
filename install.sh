#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Anima — Bootstrap Installer
# Sets up the platform (base image, manager, watcher) and directs
# you to the Manager UI to configure a provider and create agents.
#
# Usage:
#   ./install.sh               # interactive (auto-detects local vs VPS)
#   ./install.sh --local       # force local mode (skip Traefik/domain)
#   ./install.sh --quick       # minimal prompts, sensible defaults
#   ./install.sh --bare        # no Docker — run directly with Node.js
# ═══════════════════════════════════════════════════════════════════

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/brand.sh"
source "$SCRIPT_DIR/lib/platform.sh"

# ── Parse flags ───────────────────────────────────────────────────

FORCE_LOCAL=false
QUICK_MODE=false
BARE_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)  FORCE_LOCAL=true; shift ;;
    --quick)  QUICK_MODE=true; shift ;;
    --bare)   BARE_MODE=true; FORCE_LOCAL=true; shift ;;
    --help|-h)
      echo "Usage: ./install.sh [--local] [--quick] [--bare]"
      echo "  --local   Skip Traefik/domain setup (local machine)"
      echo "  --quick   Minimal prompts, sensible defaults"
      echo "  --bare    No Docker — run directly with Node.js (simplest local setup)"
      exit 0
      ;;
    *) shift ;;
  esac
done

if [ "$FORCE_LOCAL" = "true" ]; then
  ANIMA_IS_LOCAL="true"
fi

# Auto-enable quick mode when stdin is not a terminal (piped/scripted installs)
if [ ! -t 0 ] && [ "$QUICK_MODE" != "true" ]; then
  echo -e "${DIM}  Non-interactive stdin detected — enabling quick mode${NC}"
  QUICK_MODE=true
fi

# ── Banner ────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║       ${CYAN}${BRAND_NAME}${NC} ${BOLD}Setup              ║${NC}"
echo -e "${BOLD}  ║   Visual Agentic System              ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""

# Show detected environment
ENV_LABEL="$ANIMA_OS ($ANIMA_ARCH)"
[ "$ANIMA_IS_LOCAL" = "true" ] && ENV_LABEL="$ENV_LABEL — local" || ENV_LABEL="$ENV_LABEL — server"
[ "$BARE_MODE" = "true" ] && ENV_LABEL="$ENV_LABEL, bare (no Docker)"
echo -e "  ${DIM}Detected: ${ENV_LABEL}${NC}"
[ "$QUICK_MODE" = "true" ] && echo -e "  ${DIM}Quick mode: on (using sensible defaults)${NC}"
echo ""

# ══════════════════════════════════════════════════════════════════
# BARE MODE — No Docker, run directly with Node.js
# ══════════════════════════════════════════════════════════════════

if [ "$BARE_MODE" = "true" ]; then

  # ── Node.js ────────────────────────────────────────────────────
  NEED_NODE=false
  if ! command -v node &>/dev/null; then
    echo -e "${YELLOW}  Node.js is required for bare mode.${NC}"
    NEED_NODE=true
  else
    NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -lt 22 ] 2>/dev/null; then
      echo -e "${YELLOW}  Node.js 22+ required (found v${NODE_VER}). Anima uses the built-in node:sqlite module.${NC}"
      NEED_NODE=true
    fi
  fi

  if [ "$NEED_NODE" = "true" ]; then
    install_node || {
      echo -e "${RED}  Install Node.js 22+ and re-run: https://nodejs.org/${NC}"
      exit 1
    }
    hash -r 2>/dev/null
  fi

  # Find a Node.js 22+ binary — check common locations if PATH version is too old
  NODE_BIN=""
  for candidate in "$(command -v node 2>/dev/null)" /usr/bin/node /usr/local/bin/node; do
    [ -z "$candidate" ] && continue
    [ ! -x "$candidate" ] && continue
    cver=$("$candidate" --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [ "$cver" -ge 22 ] 2>/dev/null; then
      NODE_BIN="$candidate"
      break
    fi
  done

  if [ -z "$NODE_BIN" ]; then
    echo -e "${RED}  Node.js 22+ not found after install.${NC}"
    echo -e "${DIM}  'node --version' returns: $(node --version 2>/dev/null || echo 'not found')${NC}"
    echo -e "${DIM}  'which node' resolves to: $(which node 2>/dev/null || echo 'not found')${NC}"
    echo -e "${DIM}  You may have an older Node.js earlier in your PATH (nvm, snap, etc.)${NC}"
    echo -e "${DIM}  Fix: remove the old version or adjust PATH so /usr/bin comes first, then re-run.${NC}"
    exit 1
  fi

  echo -e "${GREEN}  ✓ Node.js $($NODE_BIN --version)${NC} ($NODE_BIN)"

  # ── Step 1: Install dependencies ───────────────────────────────
  echo ""
  echo -e "${BOLD}Step 1: Install dependencies${NC}"
  echo ""

  if [ ! -d "$SCRIPT_DIR/src/node_modules" ]; then
    echo -e "  ${CYAN}Installing src/ dependencies...${NC}"
    (cd "$SCRIPT_DIR/src" && npm install 2>&1 | tail -3)
    echo -e "  ${GREEN}✓ src/ dependencies installed${NC}"
  else
    echo -e "  ${GREEN}✓ src/ dependencies already installed${NC}"
  fi

  # ── Ensure shared directories ──────────────────────────────────
  SHARED_DIR="$SCRIPT_DIR/shared"
  mkdir -p "$SCRIPT_DIR/animas" "$SHARED_DIR/skills" "$SHARED_DIR/graphs"
  echo -e "  ${GREEN}✓ Shared directories ready${NC}"

  # ── Step 2: Set up the Manager ─────────────────────────────────
  echo ""
  echo -e "${BOLD}Step 2: Set up the Manager${NC}"
  echo ""

  "$SCRIPT_DIR/setup-manager.sh" --bare --quick

  MGR_ENV="$SCRIPT_DIR/manager/.env"
  MGR_PORT=$(grep '^MANAGER_PORT=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)
  MGR_PORT="${MGR_PORT:-18900}"
  MGR_USER=$(grep '^MANAGER_USER=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)
  MGR_PASS=$(grep '^MANAGER_PASS=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)

  # ── Step 3: Start services ────────────────────────────────────
  echo ""
  echo -e "${BOLD}Step 3: Starting services${NC}"
  echo ""

  echo -e "  ${CYAN}Starting manager...${NC}"
  (cd "$SCRIPT_DIR/manager" && bash run.sh >> "$SCRIPT_DIR/manager/manager.log" 2>&1) &
  MANAGER_PID=$!
  sleep 1
  if kill -0 "$MANAGER_PID" 2>/dev/null; then
    echo -e "  ${GREEN}✓ Manager running${NC} (pid $MANAGER_PID, log: manager/manager.log)"
  else
    echo -e "  ${YELLOW}⚠  Manager may have failed — check manager/manager.log${NC}"
  fi

  # Start the watcher daemon
  if [ -f "$SCRIPT_DIR/anima-watcher.js" ]; then
    echo -e "  ${CYAN}Starting watcher...${NC}"
    ANIMAS_DIR="$SCRIPT_DIR/animas" ANIMA_BARE_MODE=true nohup "$NODE_BIN" "$SCRIPT_DIR/anima-watcher.js" >> "$SCRIPT_DIR/watcher.log" 2>&1 &
    WATCHER_PID=$!
    disown "$WATCHER_PID" 2>/dev/null
    sleep 1
    if kill -0 "$WATCHER_PID" 2>/dev/null; then
      echo -e "  ${GREEN}✓ Watcher running${NC} (pid $WATCHER_PID, log: watcher.log)"
    else
      echo -e "  ${YELLOW}⚠  Watcher may have failed — check watcher.log${NC}"
    fi
  fi

  # ── Done ────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}  ║   ${GREEN}Setup complete!${NC}${BOLD}                    ║${NC}"
  echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
  echo ""
  MGR_URL="$(anima_host_url "$MGR_PORT")"
  echo -e "  ${BOLD}Open the Manager to get started:${NC}"
  echo ""
  echo -e "    ${CYAN}${MGR_URL}${NC}"
  echo -e "    ${DIM}Login: ${MGR_USER:-admin} / ${MGR_PASS}${NC}"
  echo ""
  echo -e "  ${DIM}The manager will guide you through setting up a default${NC}"
  echo -e "  ${DIM}AI provider and creating your first ${BRAND_AGENT}.${NC}"
  echo ""
  echo -e "  ${BOLD}Commands:${NC}"
  echo -e "    ${DIM}Create agent:${NC}  ./new-agent.sh"
  echo -e "    ${DIM}Stop all:${NC}      ./stop-all.sh"
  echo -e "    ${DIM}Manager logs:${NC}  tail -f manager/manager.log"
  echo -e "    ${DIM}Watcher logs:${NC}  tail -f watcher.log"
  echo ""

  # Open browser (best-effort)
  if command -v xdg-open &>/dev/null; then
    xdg-open "$MGR_URL" 2>/dev/null &
  elif command -v open &>/dev/null; then
    open "$MGR_URL" 2>/dev/null &
  elif command -v wslview &>/dev/null; then
    wslview "$MGR_URL" 2>/dev/null &
  elif [ -n "$BROWSER" ]; then
    "$BROWSER" "$MGR_URL" 2>/dev/null &
  else
    explorer.exe "$MGR_URL" 2>/dev/null &
  fi

  exit 0
fi

# ── Docker pre-flight ─────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  echo -e "${YELLOW}  Docker is not installed.${NC}"
  echo ""
  install_docker || {
    echo -e "${RED}  Docker is required. Install it first: https://docs.docker.com/get-docker/${NC}"
    exit 1
  }
fi

if ! command -v docker &>/dev/null; then
  echo -e "${RED}  Docker install failed or not in PATH. Please install manually and re-run.${NC}"
  exit 1
fi

if ! docker compose version &>/dev/null && ! docker-compose version &>/dev/null; then
  echo -e "${YELLOW}  Docker Compose is not available. Attempting to install...${NC}"
  if [ "$ANIMA_OS" = "macos" ]; then
    echo -e "  ${DIM}Docker Compose is included with Docker Desktop. Make sure Docker Desktop is running.${NC}"
    exit 1
  else
    COMPOSE_INSTALLED=false
    # Try apt first (works if Docker's repo is configured)
    if [ "$ANIMA_HAS_APT" = "true" ]; then
      sudo apt-get update -qq 2>&1 | tail -1
      sudo apt-get install -y docker-compose-plugin 2>/dev/null && COMPOSE_INSTALLED=true
    fi
    # Fallback: download the binary directly from GitHub
    if [ "$COMPOSE_INSTALLED" = "false" ]; then
      echo -e "  ${DIM}apt package not found — downloading binary from GitHub...${NC}"
      COMPOSE_ARCH="$(uname -m)"
      COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}"
      COMPOSE_TMP="/tmp/docker-compose-$$"
      echo -e "  ${DIM}Downloading ${COMPOSE_URL}${NC}"
      if curl -fSL --progress-bar "$COMPOSE_URL" -o "$COMPOSE_TMP"; then
        chmod +x "$COMPOSE_TMP"
        # Try user-level first, then system-level
        for PLUGIN_DIR in "$HOME/.docker/cli-plugins" "/usr/local/lib/docker/cli-plugins" "/usr/lib/docker/cli-plugins"; do
          mkdir -p "$PLUGIN_DIR" 2>/dev/null || sudo mkdir -p "$PLUGIN_DIR" 2>/dev/null || continue
          if mv "$COMPOSE_TMP" "$PLUGIN_DIR/docker-compose" 2>/dev/null || \
             sudo mv "$COMPOSE_TMP" "$PLUGIN_DIR/docker-compose" 2>/dev/null; then
            COMPOSE_INSTALLED=true
            break
          fi
        done
        rm -f "$COMPOSE_TMP" 2>/dev/null
      else
        echo -e "  ${RED}Download failed.${NC}"
        rm -f "$COMPOSE_TMP" 2>/dev/null
      fi
    fi
    if [ "$COMPOSE_INSTALLED" = "true" ] && (docker compose version &>/dev/null || docker-compose version &>/dev/null); then
      echo -e "${GREEN}  ✓ Docker Compose installed${NC}"
    else
      echo -e "${RED}  Could not install Docker Compose automatically.${NC}"
      echo -e "  ${DIM}Install manually: https://docs.docker.com/compose/install/${NC}"
      exit 1
    fi
  fi
fi

# Verify docker daemon is reachable
if ! docker info &>/dev/null 2>&1; then
  if [ "$ANIMA_OS" = "macos" ]; then
    echo -e "${YELLOW}  Docker daemon not reachable. Is Docker Desktop running?${NC}"
    echo -e "${DIM}  Open Docker Desktop from Applications, wait for it to start, then re-run.${NC}"
    exit 1
  elif [ "$ANIMA_OS" = "wsl" ]; then
    echo -e "${YELLOW}  Docker daemon not reachable.${NC}"
    # Try starting the service (works if Docker Engine is installed in WSL)
    if command -v service &>/dev/null; then
      echo -e "  ${DIM}Trying to start Docker service...${NC}"
      sudo service docker start 2>/dev/null && sleep 2
    fi
    if ! docker info &>/dev/null 2>&1; then
      echo -e "${YELLOW}  Docker is still not reachable. Options:${NC}"
      echo -e "    ${CYAN}1)${NC} If using Docker Desktop: make sure it's running and WSL integration is enabled"
      echo -e "    ${CYAN}2)${NC} If using Docker Engine in WSL: ${DIM}sudo service docker start${NC}"
      echo -e "    ${CYAN}3)${NC} Permission issue: ${DIM}sudo usermod -aG docker \$USER && newgrp docker${NC}"
      exit 1
    fi
  else
    echo -e "${YELLOW}  Docker is installed but the daemon is not reachable as '${USER}'.${NC}"
    # Try starting via systemctl
    if [ "$ANIMA_HAS_SYSTEMD" = "true" ]; then
      echo -e "  ${DIM}Trying to start Docker via systemd...${NC}"
      sudo systemctl start docker 2>/dev/null && sleep 2
    fi
    if ! docker info &>/dev/null 2>&1; then
      echo -e "${DIM}  Try: sudo systemctl start docker  — or: newgrp docker${NC}"
      exit 1
    fi
  fi
fi

echo -e "${GREEN}  ✓ Docker$(docker --version | sed 's/Docker version//' | cut -d, -f1)${NC}"

# ── Buildx version check (Compose build needs ≥ 0.17.0) ───────────
ensure_buildx || {
  echo -e "${RED}  Docker Buildx 0.17.0+ is required for Compose builds.${NC}"
  echo -e "${DIM}  Update Docker Desktop or install buildx manually, then re-run.${NC}"
  exit 1
}
echo ""

# ── Node.js pre-flight (needed for host-side watcher) ─────────────

if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}  Node.js is not installed.${NC}"
  echo -e "  ${DIM}The host-side watcher daemon requires Node.js on the host.${NC}"
  echo ""
  if [ "$QUICK_MODE" = "true" ]; then
    echo -e "  ${DIM}Skipping Node.js install (quick mode). Install later for the watcher.${NC}"
  else
    install_node || echo -e "  ${DIM}Skipped. The watcher will not work without Node.js.${NC}"
  fi
  echo ""
fi

if command -v node &>/dev/null; then
  echo -e "${GREEN}  ✓ Node.js $(node --version)${NC}"
fi
echo ""

# ── Step 1: Build base image ─────────────────────────────────────

echo -e "${BOLD}Step 1: Build the base image${NC}"
echo -e "${DIM}  This image is shared by all ${BRAND_AGENTS} — per-${BRAND_AGENT} images extend it.${NC}"
echo ""

if docker image inspect anima:latest &>/dev/null; then
  echo -e "  ${GREEN}anima:latest${NC} already exists."
  if [ "$QUICK_MODE" = "true" ]; then
    echo -e "${DIM}  Keeping existing image (quick mode).${NC}"
  else
    read -p "  Rebuild it? [y/N]: " REBUILD
    if [[ "$REBUILD" =~ ^[Yy]$ ]]; then
      echo ""
      echo -e "${CYAN}  Building anima:latest...${NC}"
      set +e
      (cd "$SCRIPT_DIR" && docker build -t anima:latest src/ 2>&1 | tee /tmp/anima-build.log | tail -5)
      BUILD_EXIT=${PIPESTATUS[0]}
      set -e
      if [ "$BUILD_EXIT" -ne 0 ]; then
        echo -e "${RED}  ✗ Base image build failed (exit $BUILD_EXIT)${NC}"
        echo -e "${DIM}  Full log: /tmp/anima-build.log${NC}"
        exit 1
      fi
      echo -e "${GREEN}  ✓ Base image rebuilt${NC}"
    else
      echo -e "${DIM}  Keeping existing image.${NC}"
    fi
  fi
else
  echo -e "${CYAN}  Building anima:latest...${NC}"
  set +e
  (cd "$SCRIPT_DIR" && docker build -t anima:latest src/ 2>&1 | tee /tmp/anima-build.log | tail -5)
  BUILD_EXIT=${PIPESTATUS[0]}
  set -e
  if [ "$BUILD_EXIT" -ne 0 ]; then
    echo -e "${RED}  ✗ Base image build failed (exit $BUILD_EXIT)${NC}"
    echo -e "${DIM}  Full log: /tmp/anima-build.log${NC}"
    exit 1
  fi
  echo -e "${GREEN}  ✓ Base image built${NC}"
fi

# ── Step 2: Shared directories ───────────────────────────────────

mkdir -p "$SCRIPT_DIR/animas" "$SCRIPT_DIR/shared/skills" "$SCRIPT_DIR/shared/graphs"

ensure_group 2000

if [ "$ANIMA_OS" = "macos" ]; then
  chgrp -R anima "$SCRIPT_DIR/shared" 2>/dev/null || true
  chmod 2775 "$SCRIPT_DIR/shared" "$SCRIPT_DIR/shared/skills" 2>/dev/null || true
else
  chgrp -R 2000 "$SCRIPT_DIR/shared" 2>/dev/null || sudo chgrp -R 2000 "$SCRIPT_DIR/shared" 2>/dev/null || true
  chmod 2775 "$SCRIPT_DIR/shared" "$SCRIPT_DIR/shared/skills" 2>/dev/null || sudo chmod 2775 "$SCRIPT_DIR/shared" "$SCRIPT_DIR/shared/skills" 2>/dev/null || true
fi
echo -e "${GREEN}  ✓ Shared directories ready${NC}"

# ── Step 3: Traefik (reverse proxy) ───────────────────────────────

echo ""
echo -e "${BOLD}Step 3: Ingress (reverse proxy)${NC}"
echo -e "${DIM}  All agents are accessed through Traefik at /animas/<name>${NC}"
echo ""

TRAEFIK_RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^traefik$' && echo "yes" || echo "")
if [ -n "$TRAEFIK_RUNNING" ]; then
  echo -e "  ${GREEN}✓ Traefik is already running.${NC}"
else
  TRAEFIK_ARGS="--auto"
  if [ "$ANIMA_IS_LOCAL" != "true" ]; then
    DETECTED_DOMAIN=""
    PUBLIC_IP=$(curl -sf --max-time 3 https://api.ipify.org 2>/dev/null || echo "")
    if [ -n "$PUBLIC_IP" ]; then
      echo -e "  ${DIM}Public IP: ${CYAN}${PUBLIC_IP}${NC}"
      REVERSE_DNS=$(dig +short -x "$PUBLIC_IP" 2>/dev/null | head -1 | sed 's/\.$//' || true)
      [ -n "$REVERSE_DNS" ] && echo -e "  ${DIM}Reverse DNS: ${CYAN}${REVERSE_DNS}${NC}"
    fi
    if [ "$QUICK_MODE" != "true" ]; then
      echo ""
      read -p "  Domain (blank = localhost only): " DETECTED_DOMAIN
      if [ -n "$DETECTED_DOMAIN" ]; then
        read -p "  Email for Let's Encrypt: " DETECTED_EMAIL
        TRAEFIK_ARGS="$TRAEFIK_ARGS --domain $DETECTED_DOMAIN --email ${DETECTED_EMAIL:-admin@$DETECTED_DOMAIN}"
      fi
    fi
  fi
  bash "$SCRIPT_DIR/setup-traefik.sh" $TRAEFIK_ARGS
fi


# ── Step 4: Manager (web dashboard) ──────────────────────────────

echo ""
echo -e "${BOLD}Step 4: ${BRAND_MANAGER} (web dashboard)${NC}"
echo ""

MANAGER_RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'anima-manager' && echo "yes" || echo "")
if [ -n "$MANAGER_RUNNING" ]; then
  echo -e "  ${GREEN}✓ Manager is already running.${NC}"
else
  MANAGER_ARGS=""
  [ "$QUICK_MODE" = "true" ] && MANAGER_ARGS="$MANAGER_ARGS --quick"
  bash "$SCRIPT_DIR/setup-manager.sh" $MANAGER_ARGS
fi

MGR_ENV="$SCRIPT_DIR/manager/.env"
MGR_PORT=$(grep '^MANAGER_PORT=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)
MGR_PORT="${MGR_PORT:-18900}"
MGR_USER=$(grep '^MANAGER_USER=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)
MGR_PASS=$(grep '^MANAGER_PASS=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)

# ── Step 5: Watcher service ─────────────────────────────────────

echo ""
echo -e "${BOLD}Step 5: Watcher service${NC}"
echo ""
echo -e "  ${DIM}The watcher monitors ${BRAND_AGENT} directories and handles builds,${NC}"
echo -e "  ${DIM}restarts, and stops triggered by the manager UI.${NC}"
echo ""

WATCHER_ACTIVE="inactive"
if [ "$ANIMA_HAS_SYSTEMD" = "true" ]; then
  WATCHER_ACTIVE=$(systemctl is-active anima-watcher 2>/dev/null || echo "inactive")
elif [ "$ANIMA_OS" = "macos" ]; then
  launchctl list com.anima.watcher &>/dev/null 2>&1 && WATCHER_ACTIVE="active"
fi

if [ "$WATCHER_ACTIVE" = "active" ]; then
  echo -e "  ${GREEN}✓ Watcher is already running.${NC}"
elif command -v node &>/dev/null; then
  WATCHER_INSTALLED=false
  install_watcher_service "$SCRIPT_DIR" && WATCHER_INSTALLED=true
  # Fallback: if no service manager (e.g. WSL), start directly
  if [ "$WATCHER_INSTALLED" = "false" ]; then
    echo -e "  ${CYAN}Starting watcher directly...${NC}"
    NODE_BIN_W="$(command -v node)"
    ANIMAS_DIR="$SCRIPT_DIR/animas" nohup "$NODE_BIN_W" "$SCRIPT_DIR/anima-watcher.js" >> /tmp/anima-watcher.log 2>&1 &
    WATCHER_PID=$!
    disown "$WATCHER_PID" 2>/dev/null
    sleep 1
    if kill -0 "$WATCHER_PID" 2>/dev/null; then
      echo -e "  ${GREEN}✓ Watcher running${NC} (pid $WATCHER_PID, log: /tmp/anima-watcher.log)"
    else
      echo -e "  ${YELLOW}⚠  Watcher failed to start — check /tmp/anima-watcher.log${NC}"
    fi
  fi
else
  echo -e "  ${YELLOW}⚠  Node.js not installed — skipping watcher service.${NC}"
  echo -e "  ${DIM}  Install Node.js and re-run, or start the watcher manually.${NC}"
fi

# ── Done ─────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║   ${GREEN}Setup complete!${NC}${BOLD}                    ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""

# Determine the URL from ingress config
INGRESS_FILE="$SCRIPT_DIR/animas/.ingress.json"
INGRESS_DOMAIN=""
INGRESS_HTTPS="false"
INGRESS_PORT="18000"
if [ -f "$INGRESS_FILE" ]; then
  INGRESS_DOMAIN=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(j.domain||'')}catch{}" 2>/dev/null || true)
  INGRESS_HTTPS=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(String(j.https||false))}catch{}" 2>/dev/null || true)
  INGRESS_PORT=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(String(j.httpPort||18000))}catch{}" 2>/dev/null || true)
fi

if [ -n "$INGRESS_DOMAIN" ]; then
  PROTO="http"; [ "$INGRESS_HTTPS" = "true" ] && PROTO="https"
  MGR_URL="${PROTO}://${INGRESS_DOMAIN}/manager/"
elif [ "$INGRESS_PORT" = "80" ]; then
  MGR_URL="http://localhost/manager/"
else
  MGR_URL="http://localhost:${INGRESS_PORT}/manager/"
fi

# Wait for the manager to actually respond via Traefik before showing the URL
echo -ne "  ${DIM}Waiting for manager to come online"
MGR_READY=false
for i in $(seq 1 90); do
  HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 2 "${MGR_URL}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    MGR_READY=true
    echo -e " ${GREEN}ready!${NC}"
    break
  fi
  echo -n "."
  sleep 2
done
if [ "$MGR_READY" != "true" ]; then
  echo -e " ${YELLOW}still starting (give it a moment)${NC}"
fi

echo ""
echo -e "  ${BOLD}Open the Manager to get started:${NC}"
echo ""
echo -e "    ${CYAN}${MGR_URL}${NC}"
echo -e "    ${DIM}Login: ${MGR_USER:-admin} / ${MGR_PASS}${NC}"
echo ""
echo -e "  ${DIM}The manager will guide you through setting up a default${NC}"
echo -e "  ${DIM}AI provider and creating your first ${BRAND_AGENT}.${NC}"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo -e "    ${CYAN}./new-agent.sh${NC}         — create a new ${BRAND_AGENT}"
echo -e "    ${CYAN}./stop-all.sh${NC}          — stop everything"
echo ""

# Open browser (best-effort)
if command -v xdg-open &>/dev/null; then
  xdg-open "$MGR_URL" 2>/dev/null &
elif command -v open &>/dev/null; then
  open "$MGR_URL" 2>/dev/null &
elif command -v wslview &>/dev/null; then
  wslview "$MGR_URL" 2>/dev/null &
elif [ -n "$BROWSER" ]; then
  "$BROWSER" "$MGR_URL" 2>/dev/null &
else
  explorer.exe "$MGR_URL" 2>/dev/null &
fi
