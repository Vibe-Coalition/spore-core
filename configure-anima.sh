#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# configure-anima.sh — Configure an Anima agent
#
# Covers everything: personality, web hosting, ingress, host access.
# Safe to re-run at any time — shows current values, only changes
# what you explicitly provide.
#
# Usage:
#   ./configure-anima.sh                    # interactive, pick agent
#   ./configure-anima.sh <agent-id>         # specify agent
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
ANIMAS_DIR="$SCRIPT_DIR/animas"
TRAEFIK_ENV="$SCRIPT_DIR/traefik/.env"
NETWORK_NAME="anima-web"

source "$SCRIPT_DIR/lib/domain-helper.sh" 2>/dev/null || true
source "$SCRIPT_DIR/brand.sh"

# ── Pick agent ─────────────────────────────────────────────────────

AGENT_ID="$1"

if [ -z "$AGENT_ID" ]; then
  echo ""
  echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}  ║   Configure ${CYAN}${BRAND_AGENT_CAP}${NC}${BOLD} Capabilities       ║${NC}"
  echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${BOLD}Available ${BRAND_AGENTS}:${NC}"
  for d in "$ANIMAS_DIR"/*/; do
    name=$(basename "$d")
    [[ "$name" == .* ]] && continue
    echo -e "  ${CYAN}${name}${NC}"
  done
  echo ""
  read -p "  ${BRAND_AGENT_CAP} ID: " AGENT_ID
fi

AGENT_DIR="$ANIMAS_DIR/$AGENT_ID"
if [ ! -d "$AGENT_DIR" ]; then
  echo -e "${RED}No ${BRAND_AGENT} found at ${AGENT_DIR}${NC}"; exit 1
fi

COMPOSE_FILE="$AGENT_DIR/docker-compose.yml"
ENV_FILE="$AGENT_DIR/.env"
DB="$AGENT_DIR/data/graph.db"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo -e "${RED}No docker-compose.yml found for ${AGENT_ID}${NC}"; exit 1
fi

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║     Configure ${CYAN}${AGENT_ID}${NC}${BOLD}$(printf '%*s' $((20 - ${#AGENT_ID})) '')║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "${DIM}  Press Enter to keep any current value.${NC}"
echo ""

# ── Graph helpers ──────────────────────────────────────────────────

get_aspect_attrs() {
  [ -f "$DB" ] || return
  sqlite3 "$DB" "SELECT attr.content FROM aspects a JOIN attributes attr ON attr.aspect_id=a.id WHERE a.node_id='${AGENT_ID}' AND a.name='$1' ORDER BY attr.id;" 2>/dev/null | paste -sd '|' -
}

get_node_field() {
  [ -f "$DB" ] || return
  sqlite3 "$DB" "SELECT $1 FROM nodes WHERE id='${AGENT_ID}';" 2>/dev/null
}

# ── Read current state from .env ───────────────────────────────────

CURRENT_HEALTH_PORT=$(grep "^ANIMA_HEALTH_PORT=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_WEB_PORT=$(grep "^ANIMA_WEB_PORT=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_HOST_PATHS=$(grep "^ANIMA_HOST_READ_PATHS=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
CURRENT_INGRESS_MODE=$(grep "^ANIMA_INGRESS_MODE=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_INGRESS_DOMAIN=$(grep "^ANIMA_INGRESS_DOMAIN=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_INGRESS_PATH=$(grep "^ANIMA_INGRESS_PATH=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_INGRESS_HTTPS=$(grep "^ANIMA_INGRESS_HTTPS=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_PERSONALITY_EDITABLE=$(grep "^ANIMA_PERSONALITY_EDITABLE=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_SRC_EDITABLE=$(grep "^ANIMA_SRC_EDITABLE=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_WEB_AUTH_USER=$(grep "^ANIMA_WEB_AUTH_USER=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
CURRENT_WEB_AUTH_PASS=$(grep "^ANIMA_WEB_AUTH_PASS=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)

# ── Read current personality from graph + anima.json ──────────────

CURRENT_DISPLAY_NAME=""
CURRENT_NICKNAMES=""
if [ -f "$AGENT_DIR/anima.json" ] && command -v python3 &>/dev/null; then
  CURRENT_DISPLAY_NAME=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/anima.json')); print(d.get('displayName',''))" 2>/dev/null || true)
  CURRENT_NICKNAMES=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/anima.json')); print(','.join(d.get('nicknames',[])))" 2>/dev/null || true)
fi
CURRENT_LABEL=$(get_node_field label)
CURRENT_LABEL="${CURRENT_LABEL:-${CURRENT_DISPLAY_NAME:-$AGENT_ID}}"
CURRENT_PERSONALITY=$(get_aspect_attrs personality)
CURRENT_VOICE=$(get_aspect_attrs voice)
CURRENT_COMM=$(get_aspect_attrs communication)
CURRENT_INTERESTS=$(get_aspect_attrs interests)

# ── Display current state ──────────────────────────────────────────

echo -e "${BOLD}── Current configuration ──────────────────────────────────${NC}"
echo ""
echo -e "  Name:         ${CYAN}${CURRENT_LABEL}${NC}"
[ -n "$CURRENT_NICKNAMES" ] && echo -e "  Nicknames:    ${DIM}${CURRENT_NICKNAMES}${NC}"
echo -e "  Health port:  ${CYAN}${CURRENT_HEALTH_PORT:-?}${NC}"
if [ -n "$CURRENT_WEB_PORT" ]; then
  echo -e "  Web port:     ${GREEN}${CURRENT_WEB_PORT}${NC}  ${DIM}(direct port exposure)${NC}"
else
  echo -e "  Web port:     ${DIM}disabled${NC}"
fi
if [ "$CURRENT_INGRESS_MODE" = "traefik" ] && [ -n "$CURRENT_INGRESS_DOMAIN" ]; then
  PROTO="http"
  [ "$CURRENT_INGRESS_HTTPS" = "true" ] && PROTO="https"
  echo -e "  Ingress:      ${GREEN}Traefik${NC}  ${DIM}→ ${PROTO}://${CURRENT_INGRESS_DOMAIN}${CURRENT_INGRESS_PATH}${NC}"
elif [ "$CURRENT_INGRESS_MODE" = "traefik" ]; then
  echo -e "  Ingress:      ${GREEN}Traefik${NC}  ${DIM}(path: ${CURRENT_INGRESS_PATH})${NC}"
else
  echo -e "  Ingress:      ${DIM}none${NC}"
fi
if [ -n "$CURRENT_WEB_AUTH_USER" ]; then
  echo -e "  Web auth:     ${GREEN}private${NC}  ${DIM}(user: ${CURRENT_WEB_AUTH_USER})${NC}"
elif [ -n "$CURRENT_WEB_PORT" ]; then
  echo -e "  Web auth:     ${DIM}public${NC}"
fi
[ -n "$CURRENT_HOST_PATHS" ] && echo -e "  Host read:    ${YELLOW}${CURRENT_HOST_PATHS}${NC}"
if [ "$CURRENT_PERSONALITY_EDITABLE" = "true" ]; then
  echo -e "  Personality:  ${YELLOW}editable (agent can change its identity)${NC}"
else
  echo -e "  Personality:  ${DIM}locked${NC}"
fi
if [ "$CURRENT_SRC_EDITABLE" = "true" ]; then
  echo -e "  Source:       ${YELLOW}editable (agent can self-modify code)${NC}"
else
  echo -e "  Source:       ${DIM}locked (secure)${NC}"
fi
echo ""

# ── Personality ────────────────────────────────────────────────────

echo -e "${BOLD}── Personality ───────────────────────────────────────────${NC}"
echo ""
echo -e "  ${DIM}Leave blank to keep. Type '-' to clear a field.${NC}"
echo ""

prompt_field() {
  local label="$1" current="$2"
  if [ -n "$current" ]; then
    local preview="${current:0:72}"
    [ "${#current}" -gt 72 ] && preview="${preview}…"
    echo -e "  ${DIM}Current: ${preview}${NC}" >&2
  fi
  read -p "  $label: " result
  echo "$result"
}

NEW_DISPLAY_NAME=$(prompt_field "Display name" "$CURRENT_DISPLAY_NAME")
[ -z "$NEW_DISPLAY_NAME" ] && NEW_DISPLAY_NAME="$CURRENT_DISPLAY_NAME"

NEW_NICKNAMES=$(prompt_field "Nicknames for group triggers (comma-separated)" "$CURRENT_NICKNAMES")
[ -z "$NEW_NICKNAMES" ] && NEW_NICKNAMES="$CURRENT_NICKNAMES"

NEW_VIBE=$(prompt_field "One-line vibe / description" "$CURRENT_PERSONALITY")
NEW_VOICE=$(prompt_field "Voice/tone" "$CURRENT_VOICE")
NEW_COMM=$(prompt_field "Communication style / quirks" "$CURRENT_COMM")
NEW_INTERESTS=$(prompt_field "Interests / expertise (comma-separated)" "$CURRENT_INTERESTS")

PERSONALITY_CHANGED=false
[ "$NEW_DISPLAY_NAME" != "$CURRENT_DISPLAY_NAME" ] && PERSONALITY_CHANGED=true
[ "$NEW_NICKNAMES" != "$CURRENT_NICKNAMES" ] && PERSONALITY_CHANGED=true
[ -n "$NEW_VIBE" ] && PERSONALITY_CHANGED=true
[ -n "$NEW_VOICE" ] && PERSONALITY_CHANGED=true
[ -n "$NEW_COMM" ] && PERSONALITY_CHANGED=true
[ -n "$NEW_INTERESTS" ] && PERSONALITY_CHANGED=true

# ── Web hosting ─────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Web hosting ────────────────────────────────────────────${NC}"
echo ""

# ── Web port ───────────────────────────────────────────────────────

echo -e "${BOLD}── Web port ───────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${DIM}The internal container port for the agent's web_serve tool.${NC}"
echo -e "  ${DIM}Required for both direct access and Traefik ingress.${NC}"
echo ""

if [ -n "$CURRENT_WEB_PORT" ]; then
  read -p "  Current: ${CURRENT_WEB_PORT}. New port (blank=keep, 0=disable): " WEB_PORT_INPUT
else
  read -p "  Web port (e.g. 18800, blank to skip): " WEB_PORT_INPUT
fi

NEW_WEB_PORT="$CURRENT_WEB_PORT"
DISABLE_WEB=false
if [ "$WEB_PORT_INPUT" = "0" ]; then
  DISABLE_WEB=true
  NEW_WEB_PORT=""
elif [ -n "$WEB_PORT_INPUT" ]; then
  NEW_WEB_PORT="$WEB_PORT_INPUT"
fi

# ── Ingress / routing ──────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Ingress / public routing ───────────────────────────────${NC}"
echo ""
echo -e "  How should this agent's web server be reachable from outside?"
echo ""
echo -e "    ${CYAN}1)${NC} None          — LAN/localhost only (via web port above)"
echo -e "    ${CYAN}2)${NC} Traefik       — route via domain + path (recommended for VPS)"
echo -e "    ${CYAN}3)${NC} Hints         — show Cloudflare/ngrok options for no-public-IP setups"
echo ""

# Determine current choice for display
CURRENT_CHOICE="1"
[ "$CURRENT_INGRESS_MODE" = "traefik" ] && CURRENT_CHOICE="2"

read -p "  Choice [${CURRENT_CHOICE}]: " INGRESS_CHOICE_INPUT
INGRESS_CHOICE="${INGRESS_CHOICE_INPUT:-$CURRENT_CHOICE}"

NEW_INGRESS_MODE="none"
NEW_INGRESS_DOMAIN=""
NEW_INGRESS_PATH="/animas/${AGENT_ID}"
NEW_INGRESS_HTTPS="false"

case "$INGRESS_CHOICE" in
  2)
    NEW_INGRESS_MODE="traefik"
    echo ""

    # Check if Traefik is set up
    TRAEFIK_RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x "traefik" || true)
    if [ -z "$TRAEFIK_RUNNING" ]; then
      echo -e "  ${YELLOW}⚠  Traefik doesn't appear to be running.${NC}"
      echo -e "  ${DIM}   Run ./setup-traefik.sh first to set up the ingress proxy.${NC}"
      echo ""
      read -p "  Continue configuring labels anyway? [Y/n]: " CONTINUE_TRAEFIK
      [[ "$CONTINUE_TRAEFIK" =~ ^[Nn]$ ]] && echo "  Skipping ingress." && NEW_INGRESS_MODE="none" || true
    fi

    if [ "$NEW_INGRESS_MODE" = "traefik" ]; then
      # Try to pre-fill domain from Traefik's .env
      TRAEFIK_DOMAIN=""
      if [ -f "$TRAEFIK_ENV" ]; then
        TRAEFIK_DOMAIN=$(grep "^TRAEFIK_DOMAIN=" "$TRAEFIK_ENV" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
        TRAEFIK_HTTPS_FLAG=$(grep "^TRAEFIK_HTTPS=" "$TRAEFIK_ENV" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
      fi

      DEFAULT_DOMAIN="${CURRENT_INGRESS_DOMAIN:-$TRAEFIK_DOMAIN}"
      DEFAULT_PATH="${CURRENT_INGRESS_PATH:-/animas/${AGENT_ID}}"

      echo -e "  ${DIM}Traefik will route requests to this agent's web_serve port.${NC}"
      echo ""

      if [ -n "$DEFAULT_DOMAIN" ]; then
        read -p "  Domain [${DEFAULT_DOMAIN}]: " DOMAIN_INPUT
        NEW_INGRESS_DOMAIN="${DOMAIN_INPUT:-$DEFAULT_DOMAIN}"
      else
        echo ""
        echo -e "  ${DIM}Don't have a domain yet? Enter one anyway — we'll check if DNS is set up.${NC}"
        read -p "  Domain (e.g. 2peracent.ai): " DOMAIN_INPUT
        NEW_INGRESS_DOMAIN="$DOMAIN_INPUT"
      fi

      if [ -n "$NEW_INGRESS_DOMAIN" ] && type check_domain_dns &>/dev/null; then
        check_domain_dns "$NEW_INGRESS_DOMAIN"
        DNS_RESULT=$?
        if [ "$DNS_RESULT" = "2" ]; then
          echo -e "  ${DIM}Ingress skipped. You can configure it later.${NC}"
          NEW_INGRESS_MODE="none"
        fi
      fi

    fi

    if [ "$NEW_INGRESS_MODE" = "traefik" ]; then
      read -p "  Path prefix [${DEFAULT_PATH}]: " PATH_INPUT
      NEW_INGRESS_PATH="${PATH_INPUT:-$DEFAULT_PATH}"
      # Ensure leading slash
      [[ "$NEW_INGRESS_PATH" != /* ]] && NEW_INGRESS_PATH="/${NEW_INGRESS_PATH}"

      # HTTPS default from Traefik's own config
      DEFAULT_HTTPS="Y"
      [ "$TRAEFIK_HTTPS_FLAG" = "false" ] && DEFAULT_HTTPS="N"
      [ "$CURRENT_INGRESS_HTTPS" = "false" ] && DEFAULT_HTTPS="N"
      read -p "  HTTPS via Let's Encrypt? [${DEFAULT_HTTPS}]: " HTTPS_INPUT
      HTTPS_INPUT="${HTTPS_INPUT:-$DEFAULT_HTTPS}"
      [[ "$HTTPS_INPUT" =~ ^[Yy]$ ]] && NEW_INGRESS_HTTPS="true" || NEW_INGRESS_HTTPS="false"

      PROTO="http"
      [ "$NEW_INGRESS_HTTPS" = "true" ] && PROTO="https"
      echo ""
      echo -e "  ${DIM}Route: ${CYAN}${PROTO}://${NEW_INGRESS_DOMAIN}${NEW_INGRESS_PATH}${NC}${DIM} → agent web port${NC}"
    fi
    ;;

  3)
    echo ""
    echo -e "${BOLD}  Options for hosting without a public IP:${NC}"
    echo ""
    echo -e "  ${CYAN}Cloudflare Tunnel${NC} ${DIM}(free, no open ports needed, custom domain possible)${NC}"
    echo -e "  ${DIM}  1. Install: curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | gpg --dearmor | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null${NC}"
    echo -e "  ${DIM}     echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared jammy main' | sudo tee /etc/apt/sources.list.d/cloudflared.list${NC}"
    echo -e "  ${DIM}     sudo apt update && sudo apt install cloudflared${NC}"
    echo -e "  ${DIM}  2. Authenticate: cloudflared tunnel login${NC}"
    echo -e "  ${DIM}  3. Temporary URL: cloudflared tunnel --url http://localhost:<web-port>${NC}"
    echo -e "  ${DIM}  4. Persistent: create a named tunnel and route your domain to it${NC}"
    echo -e "  ${DIM}  Docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/${NC}"
    echo ""
    echo -e "  ${CYAN}Tailscale Funnel${NC} ${DIM}(good if your users are on Tailscale)${NC}"
    echo -e "  ${DIM}  tailscale funnel <web-port>${NC}"
    echo -e "  ${DIM}  Docs: https://tailscale.com/kb/1223/funnel${NC}"
    echo ""
    echo -e "  ${CYAN}ngrok${NC} ${DIM}(quick dev/demo, free tier has random URLs)${NC}"
    echo -e "  ${DIM}  ngrok http <web-port>${NC}"
    echo -e "  ${DIM}  Docs: https://ngrok.com/docs${NC}"
    echo ""
    NEW_INGRESS_MODE="none"
    ;;

  *)
    NEW_INGRESS_MODE="none"
    ;;
esac

# ── Web auth ────────────────────────────────────────────────────────

NEW_WEB_AUTH_USER="$CURRENT_WEB_AUTH_USER"
NEW_WEB_AUTH_PASS="$CURRENT_WEB_AUTH_PASS"

if [ -n "$NEW_WEB_PORT" ] && ! $DISABLE_WEB; then
  echo ""
  echo -e "${BOLD}── Web access control ─────────────────────────────────────${NC}"
  echo ""
  if [ -n "$CURRENT_WEB_AUTH_USER" ]; then
    echo -e "  ${DIM}Currently: private (user: ${CYAN}${CURRENT_WEB_AUTH_USER}${NC}${DIM})${NC}"
    echo -e "    ${CYAN}1)${NC} Keep current auth"
    echo -e "    ${CYAN}2)${NC} Change credentials"
    echo -e "    ${CYAN}3)${NC} Make public (remove auth)"
    read -p "  Choice [1]: " AUTH_CHOICE
    case "$AUTH_CHOICE" in
      2)
        read -p "  Username: " NEW_WEB_AUTH_USER
        read -sp "  Password: " NEW_WEB_AUTH_PASS; echo ""
        ;;
      3) NEW_WEB_AUTH_USER=""; NEW_WEB_AUTH_PASS="" ;;
    esac
  else
    echo -e "  ${DIM}Currently: public${NC}"
    echo -e "  ${DIM}Note: /graph editor always requires auth — set credentials to access it.${NC}"
    echo ""
    echo -e "    ${CYAN}1)${NC} Public   — anyone can view the site"
    echo -e "    ${CYAN}2)${NC} Private  — require username/password"
    read -p "  Choice [1]: " AUTH_CHOICE
    if [ "$AUTH_CHOICE" = "2" ]; then
      read -p "  Username: " NEW_WEB_AUTH_USER
      read -sp "  Password: " NEW_WEB_AUTH_PASS; echo ""
      if [ -z "$NEW_WEB_AUTH_USER" ] || [ -z "$NEW_WEB_AUTH_PASS" ]; then
        echo -e "  ${YELLOW}Empty credentials — keeping public.${NC}"
        NEW_WEB_AUTH_USER=""; NEW_WEB_AUTH_PASS=""
      fi
    fi
  fi
fi

# ── Host read access ───────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Host filesystem read access ────────────────────────────${NC}"
echo ""
echo -e "  ${DIM}Bind-mounts host paths into the container as /host/<path> (read-only).${NC}"
echo -e "  ${YELLOW}⚠  WARNING: The agent can read ANY file in the mounted paths,${NC}"
echo -e "  ${YELLOW}   including private keys, configs, and personal data.${NC}"
echo ""

if [ -n "$CURRENT_HOST_PATHS" ]; then
  echo -e "  Currently mounted: ${YELLOW}${CURRENT_HOST_PATHS}${NC}"
  read -p "  New paths (blank=keep, 0=disable): " HOST_PATHS_INPUT
else
  read -p "  Paths to mount (comma-separated, blank=skip): " HOST_PATHS_INPUT
fi

NEW_HOST_PATHS="$CURRENT_HOST_PATHS"
DISABLE_HOST=false
if [ "$HOST_PATHS_INPUT" = "0" ]; then
  DISABLE_HOST=true
  NEW_HOST_PATHS=""
elif [ -n "$HOST_PATHS_INPUT" ]; then
  NEW_HOST_PATHS="$HOST_PATHS_INPUT"
fi

# ── Agent permissions ──────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Agent permissions ──────────────────────────────────────${NC}"
echo ""
echo -e "  ${DIM}The agent always has full read/write access to its knowledge graph${NC}"
echo -e "  ${DIM}for learning facts, memories, and relationships.${NC}"
echo ""

# Personality editing
echo -e "  ${DIM}Personality editing lets the agent change its own identity, voice, and rules.${NC}"
if [ "$CURRENT_PERSONALITY_EDITABLE" = "true" ]; then
  echo -e "  ${YELLOW}Currently: editable${NC}"
  read -p "  Keep enabled? (0 to lock) [Y/0]: " PERS_INPUT
  if [ "$PERS_INPUT" = "0" ]; then NEW_PERSONALITY_EDITABLE="false"
  else NEW_PERSONALITY_EDITABLE="true"; fi
else
  echo -e "  ${DIM}Currently: locked (recommended)${NC}"
  read -p "  Can the agent modify its own personality? [y/N]: " PERS_INPUT
  [[ "$PERS_INPUT" =~ ^[Yy]$ ]] && NEW_PERSONALITY_EDITABLE="true" || NEW_PERSONALITY_EDITABLE="false"
fi

echo ""

# Source editing
echo -e "  ${DIM}Source editing bind-mounts src/ so the agent can modify its own code.${NC}"
if [ "$CURRENT_SRC_EDITABLE" = "true" ]; then
  echo -e "  ${YELLOW}Currently: editable${NC}"
  read -p "  Keep enabled? (0 to lock) [Y/0]: " SRC_INPUT
  if [ "$SRC_INPUT" = "0" ]; then NEW_SRC_EDITABLE="false"
  else NEW_SRC_EDITABLE="true"; fi
else
  echo -e "  ${DIM}Currently: locked (secure, recommended)${NC}"
  echo -e "  ${YELLOW}⚠  Enabling this lets the agent permanently alter its own behavior.${NC}"
  read -p "  Can the agent modify its own source code? [y/N]: " SRC_INPUT
  [[ "$SRC_INPUT" =~ ^[Yy]$ ]] && NEW_SRC_EDITABLE="true" || NEW_SRC_EDITABLE="false"
fi

# ── Voice pipeline (optional) ──────────────────────────────────────

echo ""
echo -e "${BOLD}── Voice Pipeline (optional) ──────────────────────────────${NC}"
echo ""

CURRENT_DEEPGRAM_KEY=$(grep "^DEEPGRAM_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
CURRENT_XI_KEY=$(grep "^XI_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
CURRENT_OPENAI_KEY=$(grep "^OPENAI_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
CURRENT_TTS_PROVIDER=$(grep "^ANIMA_TTS_PROVIDER=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
CURRENT_TTS_VOICE=$(grep "^ANIMA_TTS_VOICE=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
CURRENT_TTS_EDGE_VOICE=$(grep "^ANIMA_TTS_EDGE_VOICE=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
CURRENT_VOICE_ENABLED=$(grep "^ANIMA_VOICE_ENABLED=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')

# Display current state
STT_STATUS="${DIM}not configured${NC}"
TTS_STATUS="${DIM}Edge TTS (free)${NC}"
[ -n "$CURRENT_DEEPGRAM_KEY" ] && STT_STATUS="${GREEN}Deepgram${NC}"
[ -n "$CURRENT_XI_KEY" ] && TTS_STATUS="${GREEN}ElevenLabs${NC}"
[ -n "$CURRENT_OPENAI_KEY" ] && [ -z "$CURRENT_XI_KEY" ] && TTS_STATUS="${GREEN}OpenAI${NC}"
[ "$CURRENT_TTS_PROVIDER" = "edge" ] && TTS_STATUS="${CYAN}Edge TTS (free)${NC}"

VOICE_STATE="${DIM}disabled${NC}"
[ "$CURRENT_VOICE_ENABLED" = "true" ] && VOICE_STATE="${GREEN}enabled${NC}"
[ -n "$CURRENT_DEEPGRAM_KEY" ] && VOICE_STATE="${GREEN}enabled (auto)${NC}"

echo -e "  Voice:  ${VOICE_STATE}"
echo -e "  STT:    ${STT_STATUS}"
echo -e "  TTS:    ${TTS_STATUS}"
echo ""

echo -e "  ${DIM}Voice lets your agent respond with speech in Discord voice${NC}"
echo -e "  ${DIM}channels and Telegram voice notes. Requires at least an STT${NC}"
echo -e "  ${DIM}key. TTS falls back to free Edge TTS if no paid key is set.${NC}"
echo ""

read -p "  Configure voice pipeline? [y/N]: " VOICE_SETUP_INPUT

NEW_DEEPGRAM_KEY="$CURRENT_DEEPGRAM_KEY"
NEW_XI_KEY="$CURRENT_XI_KEY"
NEW_OPENAI_KEY="$CURRENT_OPENAI_KEY"
NEW_TTS_PROVIDER="$CURRENT_TTS_PROVIDER"
NEW_TTS_VOICE="$CURRENT_TTS_VOICE"
NEW_TTS_EDGE_VOICE="$CURRENT_TTS_EDGE_VOICE"
VOICE_CHANGED=false

if [[ "$VOICE_SETUP_INPUT" =~ ^[Yy]$ ]]; then
  VOICE_CHANGED=true
  echo ""
  echo -e "  ${BOLD}Speech-to-Text (STT)${NC}"
  echo -e "  ${DIM}Deepgram is recommended. Free tier: 45 hours/month.${NC}"
  echo -e "  ${DIM}Get a key at: https://console.deepgram.com${NC}"
  echo ""

  if [ -n "$CURRENT_DEEPGRAM_KEY" ]; then
    MASKED_DG="${CURRENT_DEEPGRAM_KEY:0:8}...${CURRENT_DEEPGRAM_KEY: -4}"
    echo -e "  ${DIM}Current: ${MASKED_DG}${NC}"
  fi
  read -p "  Deepgram API key (blank=keep, 0=remove): " DG_INPUT
  if [ "$DG_INPUT" = "0" ]; then
    NEW_DEEPGRAM_KEY=""
  elif [ -n "$DG_INPUT" ]; then
    NEW_DEEPGRAM_KEY="$DG_INPUT"
  fi

  echo ""
  echo -e "  ${BOLD}Text-to-Speech (TTS)${NC}"
  echo ""
  echo -e "    ${CYAN}1)${NC} Edge TTS      — ${GREEN}free${NC}, no API key, Microsoft neural voices"
  echo -e "    ${CYAN}2)${NC} ElevenLabs    — highest quality, voice cloning (paid, XI_API_KEY)"
  echo -e "    ${CYAN}3)${NC} OpenAI TTS    — good quality, simple (paid, OPENAI_API_KEY)"
  echo ""

  CURRENT_TTS_CHOICE="1"
  [ -n "$CURRENT_XI_KEY" ] && CURRENT_TTS_CHOICE="2"
  [ "$CURRENT_TTS_PROVIDER" = "openai" ] && CURRENT_TTS_CHOICE="3"
  [ "$CURRENT_TTS_PROVIDER" = "edge" ] && CURRENT_TTS_CHOICE="1"

  read -p "  TTS provider [${CURRENT_TTS_CHOICE}]: " TTS_CHOICE_INPUT
  TTS_CHOICE="${TTS_CHOICE_INPUT:-$CURRENT_TTS_CHOICE}"

  case "$TTS_CHOICE" in
    2)
      NEW_TTS_PROVIDER="elevenlabs"
      echo ""
      if [ -n "$CURRENT_XI_KEY" ]; then
        MASKED_XI="${CURRENT_XI_KEY:0:8}...${CURRENT_XI_KEY: -4}"
        echo -e "  ${DIM}Current key: ${MASKED_XI}${NC}"
      fi
      read -p "  ElevenLabs API key (blank=keep): " XI_INPUT
      [ -n "$XI_INPUT" ] && NEW_XI_KEY="$XI_INPUT"

      echo -e "  ${DIM}Voice ID (e.g. JBFqnCBsd6RMkjVDRZzb for George)${NC}"
      if [ -n "$CURRENT_TTS_VOICE" ]; then
        echo -e "  ${DIM}Current: ${CURRENT_TTS_VOICE}${NC}"
      fi
      read -p "  Voice ID (blank=keep/default): " VOICE_INPUT
      [ -n "$VOICE_INPUT" ] && NEW_TTS_VOICE="$VOICE_INPUT"
      ;;
    3)
      NEW_TTS_PROVIDER="openai"
      echo ""
      if [ -n "$CURRENT_OPENAI_KEY" ]; then
        MASKED_OA="${CURRENT_OPENAI_KEY:0:8}...${CURRENT_OPENAI_KEY: -4}"
        echo -e "  ${DIM}Current key: ${MASKED_OA}${NC}"
      fi
      read -p "  OpenAI API key (blank=keep): " OA_INPUT
      [ -n "$OA_INPUT" ] && NEW_OPENAI_KEY="$OA_INPUT"

      echo -e "  ${DIM}Voice: alloy, echo, fable, onyx, nova, shimmer${NC}"
      if [ -n "$CURRENT_TTS_VOICE" ]; then
        echo -e "  ${DIM}Current: ${CURRENT_TTS_VOICE}${NC}"
      fi
      read -p "  Voice name [alloy]: " VOICE_INPUT
      [ -n "$VOICE_INPUT" ] && NEW_TTS_VOICE="$VOICE_INPUT"
      ;;
    *)
      NEW_TTS_PROVIDER="edge"
      echo ""
      echo -e "  ${DIM}Popular voices: en-US-AriaNeural, en-US-GuyNeural,${NC}"
      echo -e "  ${DIM}en-US-JennyNeural, en-GB-SoniaNeural, en-AU-NatashaNeural${NC}"
      if [ -n "$CURRENT_TTS_EDGE_VOICE" ]; then
        echo -e "  ${DIM}Current: ${CURRENT_TTS_EDGE_VOICE}${NC}"
      fi
      read -p "  Edge voice [en-US-AriaNeural]: " EDGE_VOICE_INPUT
      [ -n "$EDGE_VOICE_INPUT" ] && NEW_TTS_EDGE_VOICE="$EDGE_VOICE_INPUT"
      ;;
  esac
fi

# ── Apply changes to .env ──────────────────────────────────────────

echo ""
echo -e "${CYAN}  Updating .env...${NC}"

upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

remove_env() {
  local key="$1"
  sed -i "/^${key}=/d" "$ENV_FILE"
}

# Web port
if $DISABLE_WEB; then
  remove_env "ANIMA_WEB_PORT"
elif [ -n "$NEW_WEB_PORT" ]; then
  upsert_env "ANIMA_WEB_PORT" "$NEW_WEB_PORT"
fi

# Ingress
if [ "$NEW_INGRESS_MODE" = "traefik" ]; then
  upsert_env "ANIMA_INGRESS_MODE"   "traefik"
  upsert_env "ANIMA_INGRESS_DOMAIN" "$NEW_INGRESS_DOMAIN"
  upsert_env "ANIMA_INGRESS_PATH"   "$NEW_INGRESS_PATH"
  upsert_env "ANIMA_INGRESS_HTTPS"  "$NEW_INGRESS_HTTPS"
else
  remove_env "ANIMA_INGRESS_MODE"
  remove_env "ANIMA_INGRESS_DOMAIN"
  remove_env "ANIMA_INGRESS_PATH"
  remove_env "ANIMA_INGRESS_HTTPS"
fi

# Host paths
if $DISABLE_HOST; then
  remove_env "ANIMA_HOST_READ_PATHS"
elif [ -n "$NEW_HOST_PATHS" ]; then
  upsert_env "ANIMA_HOST_READ_PATHS" "$NEW_HOST_PATHS"
fi

# Personality editable
if [ "$NEW_PERSONALITY_EDITABLE" = "true" ]; then
  upsert_env "ANIMA_PERSONALITY_EDITABLE" "true"
else
  remove_env "ANIMA_PERSONALITY_EDITABLE"
fi

# Src editable
if [ "$NEW_SRC_EDITABLE" = "true" ]; then
  upsert_env "ANIMA_SRC_EDITABLE" "true"
else
  remove_env "ANIMA_SRC_EDITABLE"
fi

# Web auth
if [ -n "$NEW_WEB_AUTH_USER" ] && [ -n "$NEW_WEB_AUTH_PASS" ]; then
  upsert_env "ANIMA_WEB_AUTH_USER" "$NEW_WEB_AUTH_USER"
  upsert_env "ANIMA_WEB_AUTH_PASS" "$NEW_WEB_AUTH_PASS"
else
  remove_env "ANIMA_WEB_AUTH_USER"
  remove_env "ANIMA_WEB_AUTH_PASS"
fi

# Voice pipeline
if $VOICE_CHANGED; then
  # STT key
  if [ -n "$NEW_DEEPGRAM_KEY" ]; then
    upsert_env "DEEPGRAM_API_KEY" "$NEW_DEEPGRAM_KEY"
    upsert_env "ANIMA_VOICE_ENABLED" "true"
  else
    remove_env "DEEPGRAM_API_KEY"
  fi

  # TTS provider
  if [ -n "$NEW_TTS_PROVIDER" ]; then
    upsert_env "ANIMA_TTS_PROVIDER" "$NEW_TTS_PROVIDER"
  fi

  # TTS keys and voices
  if [ -n "$NEW_XI_KEY" ]; then
    upsert_env "XI_API_KEY" "$NEW_XI_KEY"
  elif [ "$NEW_TTS_PROVIDER" != "elevenlabs" ]; then
    # Don't remove if still using elevenlabs
    : # keep existing key
  fi

  if [ -n "$NEW_OPENAI_KEY" ]; then
    upsert_env "OPENAI_API_KEY" "$NEW_OPENAI_KEY"
  fi

  if [ -n "$NEW_TTS_VOICE" ]; then
    upsert_env "ANIMA_TTS_VOICE" "$NEW_TTS_VOICE"
  fi

  if [ -n "$NEW_TTS_EDGE_VOICE" ]; then
    upsert_env "ANIMA_TTS_EDGE_VOICE" "$NEW_TTS_EDGE_VOICE"
  fi

  # Auto-enable voice if STT key is set (TTS always has Edge fallback)
  if [ -n "$NEW_DEEPGRAM_KEY" ] || [ -n "$NEW_OPENAI_KEY" ]; then
    upsert_env "ANIMA_VOICE_ENABLED" "true"
  fi
fi

echo -e "${GREEN}  ✓ .env updated${NC}"

# ── Rebuild docker-compose.yml ──────────────────────────────────────

echo -e "${CYAN}  Rewriting docker-compose.yml...${NC}"

HEALTH_PORT="${CURRENT_HEALTH_PORT:-18790}"

# ── Build YAML fragments ────────────────────────────────────────────

# Host volume lines
HOST_VOLUMES=""
if [ -n "$NEW_HOST_PATHS" ] && ! $DISABLE_HOST; then
  IFS=',' read -ra HP_ARR <<< "$NEW_HOST_PATHS"
  for HP in "${HP_ARR[@]}"; do
    HP_TRIMMED=$(echo "$HP" | xargs)
    [ -z "$HP_TRIMMED" ] && continue
    HOST_VOLUMES+="      - ${HP_TRIMMED}:/host${HP_TRIMMED}:ro"$'\n'
  done
fi

# Web port mapping (direct exposure — skip if Traefik handles it)
WEB_PORT_ENV_LINE=""
WEB_PORT_MAPPING=""
if [ -n "$NEW_WEB_PORT" ] && ! $DISABLE_WEB; then
  WEB_PORT_ENV_LINE="      - ANIMA_WEB_PORT=\${ANIMA_WEB_PORT:-${NEW_WEB_PORT}}"
  # Only expose port directly if NOT going through Traefik
  if [ "$NEW_INGRESS_MODE" != "traefik" ]; then
    WEB_PORT_MAPPING="      - \"\${ANIMA_WEB_PORT:-${NEW_WEB_PORT}}:\${ANIMA_WEB_PORT:-${NEW_WEB_PORT}}\""
  fi
  # Ensure host web dir exists
  mkdir -p "$AGENT_DIR/workspace/web"
fi

# Src editable: bind-mount src as /app (rw) + anonymous volume to preserve node_modules
# Non-editable: mount plugins dir so agent-saved scripts persist
SRC_VOLUMES=""
SRC_ENV_LINE=""
BUILD_SECTION=""
IMAGE_LINE=""
if [ "$NEW_SRC_EDITABLE" = "true" ]; then
  SRC_VOLUMES="      - ./src:/app:rw"$'\n'
  SRC_VOLUMES+="      - /app/node_modules"$'\n'
  SRC_VOLUMES+="      - ./static:/app/static"$'\n'
  SRC_ENV_LINE="      - ANIMA_SRC_EDITABLE=true"
  BUILD_SECTION="    build:
      context: ./src
      dockerfile: Dockerfile"
  IMAGE_LINE="    image: anima-${AGENT_ID}:latest"
else
  SRC_VOLUMES="      - ../../src/agent:/app/agent:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/benchmark:/app/benchmark:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/graph:/app/graph:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/gateways:/app/gateways:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/providers:/app/providers:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/workers:/app/workers:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/tools:/app/tools:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/voice:/app/voice:ro"$'\n'
  SRC_VOLUMES+="      - ./static:/app/static"$'\n'
  SRC_VOLUMES+="      - ../../src/index.js:/app/index.js:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/app.js:/app/app.js:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/config.js:/app/config.js:ro"$'\n'
  SRC_VOLUMES+="      - ../../src/entrypoint.sh:/app/entrypoint.sh:ro"$'\n'
  SRC_VOLUMES+="      - ./src/plugins:/app/plugins"$'\n'
  SRC_VOLUMES+="      - ./src/seed-graph.sql:/app/seed-graph.sql:ro"$'\n'
  BUILD_SECTION=""
  IMAGE_LINE="    image: anima:latest"
fi

# Traefik labels + network
TRAEFIK_LABELS=""
TRAEFIK_NETWORKS_REF=""
TRAEFIK_NETWORKS_DEF=""

if [ "$NEW_INGRESS_MODE" = "traefik" ] && [ -n "$NEW_WEB_PORT" ]; then
  ROUTER="${AGENT_ID}"
  STRIP_MW="${AGENT_ID}-strip"
  ENTRYPOINT="web"
  TLS_LINES=""
  [ "$NEW_INGRESS_HTTPS" = "true" ] && ENTRYPOINT="websecure" && TLS_LINES="      - \"traefik.http.routers.${ROUTER}.tls.certresolver=letsencrypt\""

  TRAEFIK_LABELS="    labels:
      - \"traefik.enable=true\"
      - \"traefik.http.routers.${ROUTER}.rule=Host(\`${NEW_INGRESS_DOMAIN}\`) && PathPrefix(\`${NEW_INGRESS_PATH}\`)\"
      - \"traefik.http.routers.${ROUTER}.entrypoints=${ENTRYPOINT}\"
${TLS_LINES}
      - \"traefik.http.services.${ROUTER}.loadbalancer.server.port=${NEW_WEB_PORT}\"
      - \"traefik.http.middlewares.${STRIP_MW}.stripprefix.prefixes=${NEW_INGRESS_PATH}\"
      - \"traefik.http.routers.${ROUTER}.middlewares=${STRIP_MW}\""

  TRAEFIK_NETWORKS_REF="      - ${NETWORK_NAME}"
  TRAEFIK_NETWORKS_DEF="networks:
  ${NETWORK_NAME}:
    external: true"
fi

# ── Write compose ───────────────────────────────────────────────────

cat > "$COMPOSE_FILE" << COMPOSE
services:
  anima:
${BUILD_SECTION}
${IMAGE_LINE}
    container_name: ${AGENT_ID}
    restart: unless-stopped

    env_file:
      - .env

    environment:
      - GRAPH_DB_PATH=/data/graph.db
      - SESSION_DB_PATH=/data/sessions.db
      - ANIMA_WORKSPACE_PATH=/workspace
      - ANIMA_LOG_LEVEL=\${ANIMA_LOG_LEVEL:-info}
      - ANIMA_HEALTH_PORT=\${ANIMA_HEALTH_PORT:-${HEALTH_PORT}}
${WEB_PORT_ENV_LINE}
${SRC_ENV_LINE}
    volumes:
      - ./data:/data
      - ./.env:/data/.env
      - ./anima.json:/app/anima.json:ro
      - ./brand.json:/app/brand.json:ro
      - ./workspace:/workspace
      - ../../shared/skills:/shared/skills
${SRC_VOLUMES}${HOST_VOLUMES}
    ports:
      - "127.0.0.1:\${ANIMA_HEALTH_PORT:-${HEALTH_PORT}}:\${ANIMA_HEALTH_PORT:-${HEALTH_PORT}}"
${WEB_PORT_MAPPING}
    networks:
      - default
${TRAEFIK_NETWORKS_REF}
${TRAEFIK_LABELS}
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 256M
    memswap_limit: 8G

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

    stop_grace_period: 10s

${TRAEFIK_NETWORKS_DEF}
COMPOSE

echo -e "${GREEN}  ✓ docker-compose.yml rewritten${NC}"

# ── Default web page (first-time setup) ────────────────────────────

write_default_page() {
  local agent_id="$1" display_name="$2" web_port="$3"
  local web_dir="$AGENT_DIR/workspace/web"
  local index="$web_dir/index.html"
  mkdir -p "$web_dir"
  if [ -f "$index" ]; then return; fi   # don't overwrite existing page

  local name="${display_name:-$agent_id}"
  cat > "$index" << HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;600;700&family=Space+Mono:wght@400;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0a;
      --surface: #111;
      --border: #1f1f1f;
      --accent: #7fff7f;
      --accent2: #4fd1c5;
      --text: #e8e8e8;
      --muted: #555;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Space Grotesk', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      max-width: 560px;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 3rem 3rem 2.5rem;
      background: var(--surface);
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 1.75rem;
    }
    .status::before {
      content: '';
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    h1 {
      font-size: 2.25rem;
      font-weight: 700;
      line-height: 1.15;
      margin-bottom: 1rem;
      letter-spacing: -0.02em;
    }
    .subtitle {
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .hint {
      border-top: 1px solid var(--border);
      padding-top: 1.5rem;
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: var(--muted);
      line-height: 1.8;
    }
    .hint code {
      color: var(--accent2);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">online</div>
    <h1>${name}</h1>
    <p class="subtitle">
      Web hosting is active and working.<br>
      This page is served from <code style="font-family:monospace;color:#4fd1c5">/workspace/web/</code> inside the container.
    </p>
    <div class="hint">
      Ask me to update this page, or write files to<br>
      <code>/workspace/web/</code> using the <code>write_file</code> tool,<br>
      then run <code>web_serve { "action": "start" }</code>.
    </div>
  </div>
</body>
</html>
HTML
  echo -e "${GREEN}  ✓ Default page written → ${web_dir}/index.html${NC}"
}

# Write default page only if web port is newly configured
WEB_NEWLY_ENABLED=false
[ -z "$CURRENT_WEB_PORT" ] && [ -n "$NEW_WEB_PORT" ] && ! $DISABLE_WEB && WEB_NEWLY_ENABLED=true
if $WEB_NEWLY_ENABLED; then
  RESOLVED_NAME="${NEW_DISPLAY_NAME:-${CURRENT_DISPLAY_NAME:-$AGENT_ID}}"
  write_default_page "$AGENT_ID" "$RESOLVED_NAME" "$NEW_WEB_PORT"
fi

# ── Apply personality changes ──────────────────────────────────────

if $PERSONALITY_CHANGED; then
  echo -e "${CYAN}  Updating personality...${NC}"

  sq() { echo "${1//\'/\'\'}"; }
  SQL=""

  DISPLAY_NAME_FINAL="${NEW_DISPLAY_NAME:-$CURRENT_LABEL}"
  NICKNAMES_FINAL="${NEW_NICKNAMES:-$CURRENT_NICKNAMES}"

  if [ "$NEW_DISPLAY_NAME" != "$CURRENT_DISPLAY_NAME" ] && [ -n "$NEW_DISPLAY_NAME" ]; then
    SQL+="UPDATE nodes SET label='$(sq "$NEW_DISPLAY_NAME")', updated=datetime('now') WHERE id='${AGENT_ID}';"$'\n'
  fi

  if [ -n "$NEW_VIBE" ] && [ "$NEW_VIBE" != '-' ]; then
    SQL+="UPDATE nodes SET description='$(sq "$DISPLAY_NAME_FINAL") — $(sq "$NEW_VIBE")', updated=datetime('now') WHERE id='${AGENT_ID}';"$'\n'
  fi

  # Display aspect (name + nicknames)
  if [ -n "$DISPLAY_NAME_FINAL" ] || [ -n "$NICKNAMES_FINAL" ]; then
    SQL+="INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('${AGENT_ID}', 'display', 9, 'configure');"$'\n'
    SQL+="DELETE FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='${AGENT_ID}' AND name='display' LIMIT 1);"$'\n'
    SQL+="INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES"$'\n'
    SQL+="  ((SELECT id FROM aspects WHERE node_id='${AGENT_ID}' AND name='display' LIMIT 1), 'Display name: $(sq "$DISPLAY_NAME_FINAL")', 10, 'configure', 'configure'),"$'\n'
    SQL+="  ((SELECT id FROM aspects WHERE node_id='${AGENT_ID}' AND name='display' LIMIT 1), 'Goes by: $(sq "$NICKNAMES_FINAL")', 9, 'configure', 'configure');"$'\n'
  fi

  upsert_aspect() {
    local aspect="$1" value="$2" weight="${3:-8}"
    [ -z "$value" ] && return
    if [ "$value" = '-' ]; then
      SQL+="DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id='${AGENT_ID}' AND name='${aspect}');"$'\n'
      SQL+="DELETE FROM aspects WHERE node_id='${AGENT_ID}' AND name='${aspect}';"$'\n'
      return
    fi
    SQL+="INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('${AGENT_ID}', '${aspect}', ${weight}, 'configure');"$'\n'
    SQL+="DELETE FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='${AGENT_ID}' AND name='${aspect}' LIMIT 1);"$'\n'
    SQL+="INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES ((SELECT id FROM aspects WHERE node_id='${AGENT_ID}' AND name='${aspect}' LIMIT 1), '$(sq "$value")', 9, 'configure', 'configure');"$'\n'
    SQL+="UPDATE aspects SET weight=${weight}, extracted_with='configure' WHERE node_id='${AGENT_ID}' AND name='${aspect}';"$'\n'
  }

  [ -n "$NEW_VIBE" ]      && upsert_aspect "personality"    "$NEW_VIBE" 9
  [ -n "$NEW_VOICE" ]     && upsert_aspect "voice"          "$NEW_VOICE" 9
  [ -n "$NEW_COMM" ]      && upsert_aspect "communication"  "$NEW_COMM" 8
  [ -n "$NEW_INTERESTS" ] && upsert_aspect "interests"      "$NEW_INTERESTS" 7

  # Update anima.json
  if [ -f "$AGENT_DIR/anima.json" ] && command -v python3 &>/dev/null; then
    python3 - "$AGENT_DIR/anima.json" "$NEW_DISPLAY_NAME" "$NEW_NICKNAMES" << 'PYEOF'
import json, sys
path, display_name, nicknames_raw = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)
if display_name:
    data['displayName'] = display_name
if nicknames_raw:
    data['nicknames'] = [n.strip().lower() for n in nicknames_raw.split(',') if n.strip()]
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
PYEOF
    echo -e "${GREEN}  ✓ anima.json updated${NC}"
    # Mirror to src/anima.json if present
    if [ -f "$AGENT_DIR/src/anima.json" ]; then
      cp "$AGENT_DIR/anima.json" "$AGENT_DIR/src/anima.json"
    fi
  fi

  # Apply SQL to graph
  if [ -n "$SQL" ]; then
    CONTAINER_RUNNING_NOW=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x "$AGENT_ID" || true)
    if [ -f "$DB" ]; then
      if [ -n "$CONTAINER_RUNNING_NOW" ]; then
        echo "$SQL" | docker exec -i "$AGENT_ID" sqlite3 /data/graph.db
      else
        echo "$SQL" | sqlite3 "$DB"
      fi
      echo -e "${GREEN}  ✓ Graph updated${NC}"
    else
      echo -e "${YELLOW}  No graph.db yet (${BRAND_AGENT} hasn't started) — personality will seed on first boot.${NC}"
    fi
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║  ${GREEN}Configuration saved!${NC}${BOLD}               ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Health port:  ${CYAN}${HEALTH_PORT}${NC}"
if [ -n "$NEW_WEB_PORT" ] && ! $DISABLE_WEB; then
  echo -e "  Web port:     ${GREEN}${NEW_WEB_PORT}${NC}"
fi
if [ "$NEW_INGRESS_MODE" = "traefik" ] && [ -n "$NEW_INGRESS_DOMAIN" ]; then
  PROTO="http"; [ "$NEW_INGRESS_HTTPS" = "true" ] && PROTO="https"
  echo -e "  Public URL:   ${GREEN}${PROTO}://${NEW_INGRESS_DOMAIN}${NEW_INGRESS_PATH}/${NC}"
fi
if [ -n "$NEW_WEB_AUTH_USER" ]; then
  echo -e "  Web auth:     ${GREEN}private${NC}  ${DIM}(user: ${NEW_WEB_AUTH_USER})${NC}"
elif [ -n "$NEW_WEB_PORT" ] && ! $DISABLE_WEB; then
  echo -e "  Web auth:     ${DIM}public${NC}"
fi
if [ -n "$NEW_HOST_PATHS" ] && ! $DISABLE_HOST; then
  echo -e "  Host read:    ${YELLOW}${NEW_HOST_PATHS}${NC}"
fi
if [ "$NEW_PERSONALITY_EDITABLE" = "true" ]; then
  echo -e "  Personality:  ${YELLOW}editable${NC}"
else
  echo -e "  Personality:  ${DIM}locked${NC}"
fi
if [ "$NEW_SRC_EDITABLE" = "true" ]; then
  echo -e "  Source:       ${YELLOW}editable${NC}"
else
  echo -e "  Source:       ${DIM}locked (secure)${NC}"
fi
# Voice summary
FINAL_DG=$(grep "^DEEPGRAM_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2)
FINAL_TTS_P=$(grep "^ANIMA_TTS_PROVIDER=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')
if [ -n "$FINAL_DG" ]; then
  TTS_LABEL="${FINAL_TTS_P:-edge}"
  [ "$TTS_LABEL" = "elevenlabs" ] && TTS_LABEL="ElevenLabs"
  [ "$TTS_LABEL" = "openai" ] && TTS_LABEL="OpenAI"
  [ "$TTS_LABEL" = "edge" ] && TTS_LABEL="Edge TTS (free)"
  echo -e "  Voice:        ${GREEN}enabled${NC}  ${DIM}(STT: Deepgram, TTS: ${TTS_LABEL})${NC}"
else
  echo -e "  Voice:        ${DIM}disabled${NC}"
fi
echo ""

# ── Offer restart ──────────────────────────────────────────────────

CONTAINER_RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x "$AGENT_ID" || true)
echo ""
if [ -n "$CONTAINER_RUNNING" ]; then
  RESTART_REASON="apply docker changes"
  $PERSONALITY_CHANGED && RESTART_REASON="reload identity + apply docker changes"
  read -p "  ${BRAND_AGENT_CAP} '${AGENT_ID}' is running. Restart to ${RESTART_REASON}? [Y/n]: " RESTART_INPUT
  if [[ ! "$RESTART_INPUT" =~ ^[Nn]$ ]]; then
    echo ""
    echo -e "${CYAN}  Restarting ${AGENT_ID}...${NC}"
    (cd "$AGENT_DIR" && docker compose up -d 2>&1 | tail -5)
    echo -e "${GREEN}  ✓ Done — check logs: docker logs -f ${AGENT_ID}${NC}"
    if [ "$NEW_INGRESS_MODE" = "traefik" ] && [ -n "$NEW_INGRESS_DOMAIN" ]; then
      PROTO="http"; [ "$NEW_INGRESS_HTTPS" = "true" ] && PROTO="https"
      echo ""
      echo -e "  ${DIM}Traefik will start routing within a few seconds.${NC}"
      echo -e "  ${DIM}Test: curl -I ${PROTO}://${NEW_INGRESS_DOMAIN}${NEW_INGRESS_PATH}/${NC}"
      [ "$NEW_INGRESS_HTTPS" = "true" ] && echo -e "  ${DIM}First HTTPS request triggers Let's Encrypt cert — may take ~30s.${NC}"
    fi
  else
    echo ""
    echo -e "  Apply manually:  ${CYAN}cd ${AGENT_DIR} && docker compose up -d${NC}"
  fi
else
  echo -e "  Start when ready:  ${CYAN}cd ${AGENT_DIR} && docker compose up -d${NC}"
fi

echo ""
