#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# setup-traefik.sh — Bootstrap Traefik as the ingress proxy for Anima
#
# Run once per host. Creates:
#   traefik/docker-compose.yml
#   traefik/traefik.yml
#   traefik/acme.json  (TLS cert storage)
#   Docker network: anima-web
#   animas/.ingress.json (shared ingress state)
#
# Usage:
#   ./setup-traefik.sh                           # interactive
#   ./setup-traefik.sh --auto                    # local: HTTP on :18000, no domain
#   ./setup-traefik.sh --auto --domain X --email Y  # VPS: HTTPS on :80/:443 with domain
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
TRAEFIK_DIR="$SCRIPT_DIR/traefik"
NETWORK_NAME="anima-web"
INGRESS_FILE="$SCRIPT_DIR/animas/.ingress.json"
source "$SCRIPT_DIR/brand.sh"
source "$SCRIPT_DIR/lib/platform.sh" 2>/dev/null || true

# ── Parse args ─────────────────────────────────────────────────────
DOMAIN_ARG=""
EMAIL_ARG=""
AUTO_MODE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN_ARG="$2"; shift 2 ;;
    --email)  EMAIL_ARG="$2";  shift 2 ;;
    --auto)   AUTO_MODE=true; shift ;;
    *) shift ;;
  esac
done

# ── Check docker ───────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo -e "${RED}Docker is not installed or not in PATH.${NC}"; exit 1
fi

# ── Detect existing Traefik ────────────────────────────────────────
EXISTING_TRAEFIK_NAME=$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i traefik | head -1 | cut -f1 || true)
EXISTING_TRAEFIK_IMAGE=$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -i traefik | head -1 | cut -f2 || true)

# If our own traefik is running, skip the "existing" flow
OWN_TRAEFIK=false
if [ "$EXISTING_TRAEFIK_NAME" = "traefik" ] && [ -f "$TRAEFIK_DIR/docker-compose.yml" ]; then
  OWN_TRAEFIK=true
  EXISTING_TRAEFIK_NAME=""
fi

if [ -n "$EXISTING_TRAEFIK_NAME" ] && [ "$AUTO_MODE" != "true" ]; then
  echo -e "${GREEN}  ✓ Found running Traefik: ${CYAN}${EXISTING_TRAEFIK_NAME}${NC} ${DIM}(${EXISTING_TRAEFIK_IMAGE})${NC}"
  echo ""
  echo -e "  ${DIM}${BRAND_AGENTS_CAP} need to be on the same Docker network as Traefik${NC}"
  echo -e "  ${DIM}so it can discover and route to them. We'll create the '${NETWORK_NAME}'${NC}"
  echo -e "  ${DIM}network and connect your existing Traefik to it.${NC}"
  echo ""
  read -p "  Connect '${EXISTING_TRAEFIK_NAME}' to the '${NETWORK_NAME}' network? [Y/n]: " CONNECT_INPUT
  if [[ "$CONNECT_INPUT" =~ ^[Nn]$ ]]; then
    echo "Aborting."; exit 0
  fi

  docker network create "$NETWORK_NAME" 2>/dev/null || true

  if docker network inspect "$NETWORK_NAME" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -qw "$EXISTING_TRAEFIK_NAME"; then
    echo -e "  ${DIM}'${EXISTING_TRAEFIK_NAME}' is already on '${NETWORK_NAME}'.${NC}"
  else
    docker network connect "$NETWORK_NAME" "$EXISTING_TRAEFIK_NAME"
    echo -e "${GREEN}  ✓ Connected '${EXISTING_TRAEFIK_NAME}' to '${NETWORK_NAME}'${NC}"
  fi

  echo ""
  PUBLIC_IP=$(curl -sf --max-time 3 https://api.ipify.org 2>/dev/null || echo "")
  [ -n "$PUBLIC_IP" ] && echo -e "  ${DIM}Detected public IP: ${CYAN}${PUBLIC_IP}${NC}" && echo ""

  if [ -n "$DOMAIN_ARG" ]; then
    DOMAIN="$DOMAIN_ARG"
  else
    read -p "  Domain (e.g. example.com, blank for localhost): " DOMAIN
  fi

  USE_HTTPS=false
  ACME_EMAIL=""
  if [ -n "$DOMAIN" ]; then
    USE_HTTPS=true
    if [ -n "$EMAIL_ARG" ]; then
      ACME_EMAIL="$EMAIL_ARG"
    else
      read -p "  Admin email (for cert notices): " ACME_EMAIL
    fi
  fi

  mkdir -p "$TRAEFIK_DIR" "$(dirname "$INGRESS_FILE")"
  cat > "$TRAEFIK_DIR/.env" << ENV
TRAEFIK_CONTAINER=${EXISTING_TRAEFIK_NAME}
TRAEFIK_DOMAIN=${DOMAIN}
TRAEFIK_HTTPS=${USE_HTTPS}
TRAEFIK_ACME_EMAIL=${ACME_EMAIL}
TRAEFIK_NETWORK=${NETWORK_NAME}
TRAEFIK_EXTERNAL=true
ENV

  cat > "$INGRESS_FILE" << JSON
{"domain":"${DOMAIN}","https":${USE_HTTPS},"email":"${ACME_EMAIL}","traefikDir":"${TRAEFIK_DIR}","external":true}
JSON

  echo -e "${GREEN}  ✓ Ingress config saved${NC}"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
# Fresh Traefik install (or update)
# ═══════════════════════════════════════════════════════════════════

if [ "$AUTO_MODE" != "true" ]; then
  echo ""
  echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}  ║       ${CYAN}Traefik${NC}${BOLD} Ingress Setup           ║${NC}"
  echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${DIM}Traefik routes all traffic so you access agents at${NC}"
  echo -e "  ${DIM}/animas/<name> instead of scattered ports.${NC}"
  echo ""
fi

# ── Domain + email ─────────────────────────────────────────────────

DOMAIN="${DOMAIN_ARG}"
ACME_EMAIL="${EMAIL_ARG}"

if [ "$AUTO_MODE" != "true" ] && [ -z "$DOMAIN" ]; then
  PUBLIC_IP=$(curl -sf --max-time 3 https://api.ipify.org 2>/dev/null || echo "")
  if [ -n "$PUBLIC_IP" ]; then
    echo -e "  ${DIM}Detected public IP: ${CYAN}${PUBLIC_IP}${NC}"
    REVERSE_DNS=$(dig +short -x "$PUBLIC_IP" 2>/dev/null | head -1 | sed 's/\.$//' || true)
    [ -n "$REVERSE_DNS" ] && echo -e "  ${DIM}Reverse DNS: ${CYAN}${REVERSE_DNS}${NC}"
    echo ""
  fi

  read -p "  Domain (blank = localhost only): " DOMAIN
  if [ -n "$DOMAIN" ]; then
    read -p "  Email for Let's Encrypt: " ACME_EMAIL
  fi
fi

USE_HTTPS=false
[ -n "$DOMAIN" ] && USE_HTTPS=true

if [ "$AUTO_MODE" = "true" ] && [ -z "$DOMAIN" ]; then
  echo -e "  ${DIM}Setting up Traefik for local access${NC}"
fi

# Local installs use a high port to avoid conflicts; VPS uses standard 80/443
if [ -n "$DOMAIN" ]; then
  TRAEFIK_HTTP_PORT=80
  BIND_ADDR="0.0.0.0"
else
  TRAEFIK_HTTP_PORT=18000
  BIND_ADDR="127.0.0.1"
fi

# Respect externalAccess from existing ingress config (re-runs / upgrades)
if [ -f "$INGRESS_FILE" ]; then
  EA=$(grep -o '"externalAccess":true' "$INGRESS_FILE" 2>/dev/null || true)
  [ -n "$EA" ] && BIND_ADDR="0.0.0.0"
fi

# ── Create directories + network ───────────────────────────────────

mkdir -p "$TRAEFIK_DIR" "$(dirname "$INGRESS_FILE")"
docker network create "$NETWORK_NAME" 2>/dev/null || true

# ── Write traefik.yml ──────────────────────────────────────────────

if $USE_HTTPS; then
  ENTRYPOINTS_CONFIG="entryPoints:
  web:
    address: \":${TRAEFIK_HTTP_PORT}\"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
  websecure:
    address: \":443\""
  CERT_RESOLVER_CONFIG="certificatesResolvers:
  letsencrypt:
    acme:
      email: ${ACME_EMAIL}
      storage: /acme.json
      httpChallenge:
        entryPoint: web"
else
  ENTRYPOINTS_CONFIG="entryPoints:
  web:
    address: \":${TRAEFIK_HTTP_PORT}\""
  CERT_RESOLVER_CONFIG=""
fi

cat > "$TRAEFIK_DIR/traefik.yml" << TRAEFIKYML
global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: INFO

api:
  dashboard: true
  insecure: false

${ENTRYPOINTS_CONFIG}

${CERT_RESOLVER_CONFIG}

providers:
  docker:
    endpoint: "tcp://docker-proxy:2375"
    exposedByDefault: false
    network: ${NETWORK_NAME}
TRAEFIKYML

echo -e "  ${GREEN}✓ traefik.yml${NC}"

# ── Write acme.json ────────────────────────────────────────────────
if $USE_HTTPS; then
  touch "$TRAEFIK_DIR/acme.json"
  chmod 600 "$TRAEFIK_DIR/acme.json"
fi

# ── Write docker-compose.yml ───────────────────────────────────────

ACME_VOLUME=""
$USE_HTTPS && ACME_VOLUME="      - ./acme.json:/acme.json"

cat > "$TRAEFIK_DIR/docker-compose.yml" << COMPOSE
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    container_name: docker-proxy
    restart: unless-stopped
    privileged: true
    environment:
      CONTAINERS: 1
      NETWORKS: 1
      SERVICES: 0
      TASKS: 0
      POST: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - proxy-internal

  traefik:
    image: traefik:v3
    container_name: traefik
    restart: unless-stopped
    depends_on:
      - docker-proxy
    security_opt:
      - no-new-privileges:true

    ports:
      - "${BIND_ADDR}:${TRAEFIK_HTTP_PORT}:${TRAEFIK_HTTP_PORT}"
$([ "$USE_HTTPS" = "true" ] && echo '      - "443:443"')
      - "127.0.0.1:8080:8080"

    volumes:
      - ./traefik.yml:/etc/traefik/traefik.yml:ro
${ACME_VOLUME}

    networks:
      - proxy-internal
      - ${NETWORK_NAME}

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  proxy-internal:
    internal: true
  ${NETWORK_NAME}:
    external: true
COMPOSE

echo -e "  ${GREEN}✓ docker-compose.yml${NC}"

# ── Write .env ─────────────────────────────────────────────────────
cat > "$TRAEFIK_DIR/.env" << ENV
TRAEFIK_DOMAIN=${DOMAIN}
TRAEFIK_HTTPS=${USE_HTTPS}
TRAEFIK_ACME_EMAIL=${ACME_EMAIL}
TRAEFIK_NETWORK=${NETWORK_NAME}
TRAEFIK_HTTP_PORT=${TRAEFIK_HTTP_PORT}
ENV

# ── Write shared ingress config ────────────────────────────────────
cat > "$INGRESS_FILE" << JSON
{"domain":"${DOMAIN}","https":${USE_HTTPS},"email":"${ACME_EMAIL}","traefikDir":"${TRAEFIK_DIR}","external":false,"httpPort":${TRAEFIK_HTTP_PORT},"externalAccess":$([ "$BIND_ADDR" = "0.0.0.0" ] && echo true || echo false)}
JSON

echo -e "  ${GREEN}✓ Ingress config saved${NC}"

# ── Start Traefik ──────────────────────────────────────────────────

START=true
if [ "$AUTO_MODE" != "true" ]; then
  read -p "  Start Traefik now? [Y/n]: " START_INPUT
  [[ "$START_INPUT" =~ ^[Nn]$ ]] && START=false
fi

if $START; then
  echo -e "  ${CYAN}Starting Traefik...${NC}"
  (cd "$TRAEFIK_DIR" && docker compose up -d 2>&1 | tail -5)
  sleep 2
  if docker ps --format '{{.Names}}' | grep -q '^traefik$'; then
    echo -e "  ${GREEN}✓ Traefik is running${NC}"
  else
    echo -e "  ${YELLOW}⚠  Traefik may have failed — check: docker logs traefik${NC}"
  fi
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
if [ -n "$DOMAIN" ]; then
  PROTO="http"; $USE_HTTPS && PROTO="https"
  echo -e "  ${BOLD}URL:${NC}  ${CYAN}${PROTO}://${DOMAIN}/${NC}"
elif [ "$TRAEFIK_HTTP_PORT" = "80" ]; then
  echo -e "  ${BOLD}URL:${NC}  ${CYAN}http://localhost/${NC}"
else
  echo -e "  ${BOLD}URL:${NC}  ${CYAN}http://localhost:${TRAEFIK_HTTP_PORT}/${NC}"
fi
echo -e "  ${DIM}Dashboard: http://localhost:8080${NC}"
echo ""
