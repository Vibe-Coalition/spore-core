#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# setup-manager.sh — Set up Anima Manager web UI
#
# Creates credentials, generates a service key, configures Traefik
# routing, and starts the manager container.
# ═══════════════════════════════════════════════════════════════════

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_DIR="$SCRIPT_DIR/manager"
ENV_FILE="$MANAGER_DIR/.env"
source "$SCRIPT_DIR/brand.sh"
source "$SCRIPT_DIR/lib/platform.sh" 2>/dev/null || true

LOCAL_MODE=false
BARE_MODE=false
QUICK_MODE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL_MODE=true; shift ;;
    --bare)  BARE_MODE=true; LOCAL_MODE=true; shift ;;
    --quick) QUICK_MODE=true; shift ;;
    *) shift ;;
  esac
done
[ "$LOCAL_MODE" = "true" ] && ANIMA_IS_LOCAL="true"
ANIMA_IS_LOCAL="${ANIMA_IS_LOCAL:-false}"

# Auto-enable quick mode when stdin is not a terminal
if [ ! -t 0 ] && [ "$QUICK_MODE" != "true" ]; then
  QUICK_MODE=true
fi

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║   Setup ${CYAN}${BRAND_MANAGER}${NC}${BOLD}          ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${DIM}The manager provides a secure web UI for configuring${NC}"
echo -e "  ${DIM}all your ${BRAND_AGENTS}, managing users, and monitoring health.${NC}"
echo ""

# ── Credentials ───────────────────────────────────────────────────

if [ -f "$ENV_FILE" ]; then
  EXISTING_USER=$(grep "^MANAGER_USER=" "$ENV_FILE" 2>/dev/null | cut -d= -f2)
  EXISTING_PASS=$(grep "^MANAGER_PASS=" "$ENV_FILE" 2>/dev/null | cut -d= -f2)
  if [ -n "$EXISTING_USER" ] && [ -n "$EXISTING_PASS" ]; then
    echo -e "  ${DIM}Existing credentials found (user: ${CYAN}${EXISTING_USER}${NC}${DIM})${NC}"
    if [ "$QUICK_MODE" = "true" ]; then
      MANAGER_USER="$EXISTING_USER"
      MANAGER_PASS="$EXISTING_PASS"
    else
      read -p "  Keep existing credentials? [Y/n]: " KEEP_CREDS
      if [[ ! "$KEEP_CREDS" =~ ^[Nn]$ ]]; then
        MANAGER_USER="$EXISTING_USER"
        MANAGER_PASS="$EXISTING_PASS"
      fi
    fi
  fi
fi

if [ -z "$MANAGER_USER" ]; then
  CREDS_CHANGED=true
  if [ "$QUICK_MODE" = "true" ]; then
    MANAGER_USER="admin"
    MANAGER_PASS=$(openssl rand -base64 12 2>/dev/null || head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)
    echo -e "  ${DIM}Quick mode — generated credentials:${NC}"
    echo -e "  ${CYAN}Username: ${MANAGER_USER}${NC}"
    echo -e "  ${CYAN}Password: ${MANAGER_PASS}${NC}"
  else
    echo -e "${BOLD}── Super User Credentials ────────────────────────────────${NC}"
    echo ""
    echo -e "  ${DIM}This becomes the initial super user — they can see all ${BRAND_AGENTS}${NC}"
    echo -e "  ${DIM}and manage other user accounts from the dashboard.${NC}"
    echo ""
    read -p "  Username [admin]: " MANAGER_USER
    MANAGER_USER="${MANAGER_USER:-admin}"
    read -sp "  Password: " MANAGER_PASS; echo ""

    if [ -z "$MANAGER_PASS" ]; then
      MANAGER_PASS=$(openssl rand -base64 18 2>/dev/null || head -c 24 /dev/urandom | base64)
      echo -e "  ${YELLOW}Generated password: ${MANAGER_PASS}${NC}"
      echo -e "  ${DIM}Save this — it won't be shown again.${NC}"
    fi
  fi
  # Remove stale user DB so the manager bootstraps with the new credentials
  USERS_DB="$SCRIPT_DIR/animas/.anima-users.json"
  if [ -f "$USERS_DB" ]; then
    rm -f "$USERS_DB"
    echo -e "  ${DIM}Cleared old user database (will re-bootstrap with new credentials)${NC}"
  fi
fi

# ── Port ──────────────────────────────────────────────────────────

MANAGER_PORT=18900
if [ "$QUICK_MODE" != "true" ]; then
  echo ""
  read -p "  Manager port [${MANAGER_PORT}]: " PORT_INPUT
  [ -n "$PORT_INPUT" ] && MANAGER_PORT="$PORT_INPUT"
fi

# ── Traefik (always on — read domain from .ingress.json) ──────────

MANAGER_DOMAIN=""
MANAGER_ENTRYPOINT="web"
MANAGER_CERTRESOLVER=""

INGRESS_FILE="$SCRIPT_DIR/animas/.ingress.json"
INGRESS_HTTP_PORT="18000"
if [ -f "$INGRESS_FILE" ]; then
  MANAGER_DOMAIN=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(j.domain||'')}catch{}" 2>/dev/null || true)
  INGRESS_HTTPS=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(String(j.https||false))}catch{}" 2>/dev/null || true)
  INGRESS_HTTP_PORT=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(String(j.httpPort||18000))}catch{}" 2>/dev/null || true)
  if [ "$INGRESS_HTTPS" = "true" ]; then
    MANAGER_ENTRYPOINT="websecure"
    MANAGER_CERTRESOLVER="letsencrypt"
  fi
fi

if [ -n "$MANAGER_DOMAIN" ]; then
  PROTO="http"; [ "$MANAGER_ENTRYPOINT" = "websecure" ] && PROTO="https"
  echo -e "  ${DIM}Traefik routing: ${CYAN}${PROTO}://${MANAGER_DOMAIN}/manager/${NC}"
elif [ "$INGRESS_HTTP_PORT" = "80" ]; then
  echo -e "  ${DIM}Traefik routing: ${CYAN}http://localhost/manager/${NC}"
else
  echo -e "  ${DIM}Traefik routing: ${CYAN}http://localhost:${INGRESS_HTTP_PORT}/manager/${NC}"
fi

# ── Write .env ────────────────────────────────────────────────────

# Generate a service key only if one doesn't exist
if [ -f "$ENV_FILE" ]; then
  EXISTING_KEY=$(grep '^MANAGER_SERVICE_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)
fi
MANAGER_SERVICE_KEY="${EXISTING_KEY:-$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p | tr -d '\n')}"

# Preserve any extra lines from the existing .env (e.g. manually added vars)
EXTRA_LINES=""
if [ -f "$ENV_FILE" ]; then
  EXTRA_LINES=$(grep -vE '^(MANAGER_USER|MANAGER_PASS|MANAGER_PORT|MANAGER_SERVICE_KEY|MANAGER_DOMAIN|MANAGER_ENTRYPOINT|MANAGER_CERTRESOLVER|HOST_UID|HOST_GID)=' "$ENV_FILE" | grep -v '^#' | grep -v '^$' || true)
fi

cat > "$ENV_FILE" << ENV
MANAGER_USER=${MANAGER_USER}
MANAGER_PASS=${MANAGER_PASS}
MANAGER_PORT=${MANAGER_PORT}
MANAGER_SERVICE_KEY=${MANAGER_SERVICE_KEY}
MANAGER_DOMAIN=${MANAGER_DOMAIN}
MANAGER_ENTRYPOINT=${MANAGER_ENTRYPOINT}
MANAGER_CERTRESOLVER=${MANAGER_CERTRESOLVER}
HOST_UID=$(id -u)
HOST_GID=$(id -g)
ENV

# Re-append any extra lines that were preserved
if [ -n "$EXTRA_LINES" ]; then
  echo "$EXTRA_LINES" >> "$ENV_FILE"
fi

# Add bare mode flag to .env if in bare mode
if [ "$BARE_MODE" = "true" ]; then
  echo "ANIMA_BARE_MODE=true" >> "$ENV_FILE"
  echo "ANIMAS_DIR=$SCRIPT_DIR/animas" >> "$ENV_FILE"
  echo "SHARED_DIR=$SCRIPT_DIR/shared" >> "$ENV_FILE"
fi

echo ""
echo -e "${GREEN}  ✓ Manager .env written${NC}"
echo -e "${GREEN}  ✓ Service key generated${NC}"

# ── Ensure shared directories & files ─────────────────────────────

mkdir -p "$SCRIPT_DIR/shared/skills" "$SCRIPT_DIR/shared/graphs"
if [ ! -f "$MANAGER_DIR/defaults.env" ]; then
  if [ -f "$MANAGER_DIR/defaults.env.example" ]; then
    cp "$MANAGER_DIR/defaults.env.example" "$MANAGER_DIR/defaults.env"
  else
    touch "$MANAGER_DIR/defaults.env"
  fi
fi
if [ "$ANIMA_OS" = "macos" ]; then
  chgrp -R anima "$SCRIPT_DIR/shared" 2>/dev/null || true
  chmod 2775 "$SCRIPT_DIR/shared" "$SCRIPT_DIR/shared/skills" 2>/dev/null || true
elif getent group 2000 &>/dev/null; then
  chgrp -R 2000 "$SCRIPT_DIR/shared" 2>/dev/null || true
  chmod 2775 "$SCRIPT_DIR/shared" "$SCRIPT_DIR/shared/skills" 2>/dev/null || true
fi

if [ "$BARE_MODE" = "true" ]; then
  # ── Bare mode: npm install + run.sh ──────────────────────────────

  echo -e "  ${CYAN}Installing manager dependencies...${NC}"
  (cd "$MANAGER_DIR" && npm install 2>&1 | tail -3)
  echo -e "  ${GREEN}✓ Dependencies installed${NC}"

  # Detect Node.js binary
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
  NODE_BIN="${NODE_BIN:-$(command -v node)}"

  # Generate run.sh for manager
  cat > "$MANAGER_DIR/run.sh" << RUNEOF
#!/bin/bash
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
set -a; source "\$SCRIPT_DIR/.env" 2>/dev/null; set +a
export ANIMAS_DIR="\${ANIMAS_DIR:-\$SCRIPT_DIR/../animas}"
export SHARED_DIR="\${SHARED_DIR:-\$SCRIPT_DIR/../shared}"
cd "\$SCRIPT_DIR"
exec "$NODE_BIN" server.js
RUNEOF
  chmod +x "$MANAGER_DIR/run.sh"
  echo -e "  ${GREEN}✓ run.sh generated${NC}"

  # Optionally install as a system service
  if [ "$QUICK_MODE" != "true" ]; then
    echo ""
    read -p "  Install manager as a system service? [y/N]: " INSTALL_SVC
  else
    INSTALL_SVC="n"
  fi

  if [[ "$INSTALL_SVC" =~ ^[Yy]$ ]]; then
    if [ "$ANIMA_HAS_SYSTEMD" = "true" ]; then
      sudo tee /etc/systemd/system/anima-manager.service > /dev/null << SVCEOF
[Unit]
Description=Anima Manager — web-based agent management
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$MANAGER_DIR
ExecStart=$NODE_BIN $MANAGER_DIR/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
EnvironmentFile=$ENV_FILE
Environment=ANIMAS_DIR=$SCRIPT_DIR/animas
Environment=SHARED_DIR=$SCRIPT_DIR/shared

[Install]
WantedBy=multi-user.target
SVCEOF
      sudo systemctl daemon-reload
      sudo systemctl enable anima-manager
      sudo systemctl start anima-manager
      echo -e "  ${GREEN}✓ anima-manager.service installed and started${NC}"
    elif [ "$ANIMA_OS" = "macos" ]; then
      local plist="$HOME/Library/LaunchAgents/com.anima.manager.plist"
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.anima.manager</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$MANAGER_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$MANAGER_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANIMAS_DIR</key><string>$SCRIPT_DIR/animas</string>
    <key>SHARED_DIR</key><string>$SCRIPT_DIR/shared</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/anima-manager.log</string>
  <key>StandardErrorPath</key><string>/tmp/anima-manager.log</string>
</dict>
</plist>
PLISTEOF
      launchctl load "$plist" 2>/dev/null || true
      echo -e "  ${GREEN}✓ Manager installed as macOS Launch Agent${NC}"
    else
      echo -e "  ${YELLOW}⚠  No systemd or launchd. Run manually: cd manager && ./run.sh${NC}"
    fi
  fi

  echo ""
  echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}  ║  ${GREEN}${BRAND_MANAGER} ready!${NC}${BOLD}          ║${NC}"
  echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  To start:   ${CYAN}cd manager && ./run.sh${NC}"
  echo -e "  URL:        ${CYAN}$(anima_host_url "$MANAGER_PORT")${NC}"
  echo ""
  echo -e "  Super user: ${CYAN}${MANAGER_USER}${NC}"
  echo -e "  Password:   ${DIM}(as configured above)${NC}"
  echo ""
  echo -e "  ${DIM}Service key: ${MANAGER_SERVICE_KEY}${NC}"
  echo -e "  ${DIM}(agents need MANAGER_SERVICE_KEY in their .env to connect)${NC}"
  echo ""

else
  # ── Docker mode ────────────────────────────────────────────────

  docker network create anima-web 2>/dev/null || true

  # ── Generate docker-compose.yml with Traefik labels ──────────────

  # Always enable Traefik labels — PathPrefix-only when no domain, Host+PathPrefix when domain is set
  TLS_LINE=""
  ROUTER_RULE="PathPrefix(\`/manager\`)"
  if [ -n "$MANAGER_DOMAIN" ]; then
    ROUTER_RULE="Host(\`${MANAGER_DOMAIN}\`) && PathPrefix(\`/manager\`)"
    [ "$MANAGER_ENTRYPOINT" = "websecure" ] && TLS_LINE="
      - \"traefik.http.routers.anima-manager.tls.certresolver=${MANAGER_CERTRESOLVER}\""
  fi
  TRAEFIK_LABELS="      - \"traefik.enable=true\"
      - \"traefik.docker.network=anima-web\"
      - \"traefik.http.routers.anima-manager.rule=${ROUTER_RULE}\"
      - \"traefik.http.routers.anima-manager.entrypoints=${MANAGER_ENTRYPOINT}\"${TLS_LINE}
      - \"traefik.http.services.anima-manager.loadbalancer.server.port=${MANAGER_PORT}\"
      - \"traefik.http.middlewares.manager-strip.stripprefix.prefixes=/manager\"
      - \"traefik.http.routers.anima-manager.middlewares=manager-strip\""

  cat > "$MANAGER_DIR/docker-compose.yml" << COMPOSE
services:
  manager:
    build:
      context: .
      dockerfile: Dockerfile
    image: anima-manager:latest
    container_name: anima-manager
    restart: unless-stopped
    user: "\${HOST_UID:-1000}:\${HOST_GID:-1000}"
    group_add:
      - "2000"
    security_opt:
      - no-new-privileges:true

    extra_hosts:
      - "host.docker.internal:host-gateway"

    env_file:
      - .env

    environment:
      - ANIMAS_DIR=/animas
      - MANAGER_PORT=\${MANAGER_PORT:-${MANAGER_PORT}}

    volumes:
      - ../animas:/animas:rw
      - ../shared:/shared:rw
      - ../src:/anima-base-src:ro
      - ./defaults.env:/app/defaults.env:rw
      - ../brand.json:/app/brand.json:ro
      - ./static:/app/static:ro

    ports:
      - "127.0.0.1:\${MANAGER_PORT:-${MANAGER_PORT}}:\${MANAGER_PORT:-${MANAGER_PORT}}"

    networks:
      - default
      - anima-web

    labels:
${TRAEFIK_LABELS}

    deploy:
      resources:
        limits:
          memory: 128M

    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "2"

networks:
  anima-web:
    external: true
COMPOSE

  echo -e "${GREEN}  ✓ docker-compose.yml generated${NC}"

  # ── Build and start ───────────────────────────────────────────────

  ensure_buildx || echo -e "${YELLOW}  ⚠  Buildx may be too old — build could fail.${NC}"
  echo -e "${CYAN}  Building and starting manager...${NC}"
  (cd "$MANAGER_DIR" && docker compose up -d --build 2>&1 | tail -5)

  echo ""
  echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}  ║  ${GREEN}${BRAND_MANAGER} is running!${NC}${BOLD}      ║${NC}"
  echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
  echo ""
  if [ -n "$MANAGER_DOMAIN" ]; then
    PROTO="http"; [ "$MANAGER_ENTRYPOINT" = "websecure" ] && PROTO="https"
    echo -e "  URL:      ${GREEN}${PROTO}://${MANAGER_DOMAIN}/manager/${NC}"
  elif [ "$INGRESS_HTTP_PORT" = "80" ]; then
    echo -e "  URL:      ${CYAN}http://localhost/manager/${NC}"
  else
    echo -e "  URL:      ${CYAN}http://localhost:${INGRESS_HTTP_PORT}/manager/${NC}"
  fi
  echo -e "  ${DIM}Direct:   $(anima_host_url "$MANAGER_PORT")${NC}"
  echo ""
  echo -e "  Super user: ${CYAN}${MANAGER_USER}${NC}"
  echo -e "  Password:   ${DIM}(as configured above)${NC}"
  echo ""
  echo -e "  ${DIM}The super user account is bootstrapped automatically on first login.${NC}"
  echo -e "  ${DIM}Additional users can be created from the Users panel in the dashboard.${NC}"
  echo ""
  echo -e "  Logs:     ${CYAN}docker logs -f anima-manager${NC}"
  echo ""
fi
