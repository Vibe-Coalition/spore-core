#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# new-agent.sh — Create a new Anima agent
#
# Usage:
#   ./new-agent.sh                        # interactive
#   ./new-agent.sh <name>                 # skip name prompt
#   ./new-agent.sh <name> --from <other>  # duplicate an existing agent's src
#   ./new-agent.sh <name> --port <n>      # specify port
# ═══════════════════════════════════════════════════════════════════

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANIMAS_DIR="$SCRIPT_DIR/animas"
TEMPLATE_DIR="$ANIMAS_DIR/.template"
TRAEFIK_ENV="$SCRIPT_DIR/traefik/.env"
NETWORK_NAME="anima-web"

source "$SCRIPT_DIR/lib/domain-helper.sh" 2>/dev/null || true
source "$SCRIPT_DIR/lib/platform.sh" 2>/dev/null || true
source "$SCRIPT_DIR/brand.sh"

# ── Parse args ─────────────────────────────────────────────────────

NAME_ARG=""
FROM_ARG=""
PORT_ARG=""
QUICK_MODE=false
FORCE_LOCAL=false
SKIP_SIDECAR=false
BARE_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_ARG="$2"; shift 2 ;;
    --port) PORT_ARG="$2"; shift 2 ;;
    --quick) QUICK_MODE=true; shift ;;
    --local) FORCE_LOCAL=true; shift ;;
    --bare)  BARE_MODE=true; FORCE_LOCAL=true; SKIP_SIDECAR=true; shift ;;
    --no-sidecar) SKIP_SIDECAR=true; shift ;;
    --help|-h)
      echo "Usage: ./new-agent.sh [name] [--from <agent>] [--port <n>] [--quick] [--local] [--bare] [--no-sidecar]"
      echo "  --quick        Minimal prompts, sensible defaults"
      echo "  --local        Skip ingress/Traefik setup"
      echo "  --bare         No Docker — generate run.sh + host-path .env"
      echo "  --no-sidecar   Skip SSH credential sidecar"
      exit 0
      ;;
    --*) echo "Unknown option: $1"; shift ;;
    *) [ -z "$NAME_ARG" ] && NAME_ARG="$1"; shift ;;
  esac
done

[ "$FORCE_LOCAL" = "true" ] && ANIMA_IS_LOCAL="${ANIMA_IS_LOCAL:-true}"
ANIMA_IS_LOCAL="${ANIMA_IS_LOCAL:-false}"

# Auto-enable quick mode when stdin is not a terminal
if [ ! -t 0 ] && [ "$QUICK_MODE" != "true" ]; then
  QUICK_MODE=true
fi

# ── Banner ─────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║   ${BRAND_CREATE_VERB} a new ${CYAN}${BRAND_AGENT_CAP}${NC}${BOLD}                ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Identity ───────────────────────────────────────────────

echo -e "${BOLD}── Identity ──────────────────────────────────────────────${NC}"
echo ""

if [ -z "$NAME_ARG" ]; then
  read -p "  Display name (e.g. \"Harry The Alien\"): " DISPLAY_NAME
else
  DISPLAY_NAME="$NAME_ARG"
  echo -e "  Display name: ${CYAN}${DISPLAY_NAME}${NC}"
fi

if [ -z "$DISPLAY_NAME" ]; then
  echo -e "${RED}Display name is required.${NC}"; exit 1
fi

AGENT_ID=$(echo "$DISPLAY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr '_' '-' | sed 's/[^a-z0-9-]//g')
echo -e "  ${DIM}Agent ID: ${AGENT_ID}${NC}"

AGENT_DIR="$ANIMAS_DIR/$AGENT_ID"
if [ -d "$AGENT_DIR" ]; then
  echo -e "${RED}\"$AGENT_ID\" already exists at $AGENT_DIR${NC}"; exit 1
fi

echo ""
read -p "  Nicknames for group chat triggers (comma-separated, e.g. \"harry, h\"): " NICKNAMES_RAW
NICKNAMES_RAW="${NICKNAMES_RAW:-$(echo "$DISPLAY_NAME" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')}"

# ── Step 2: Personality ────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Personality ───────────────────────────────────────────${NC}"
echo ""

if [ "$QUICK_MODE" = "true" ]; then
  echo -e "  ${DIM}Using defaults (quick mode). Customize later via the graph.${NC}"
  VIBE="helpful and knowledgeable AI assistant"
  COMM_STYLE="clear and direct"
  QUIRKS=""
  INTERESTS_RAW=""
else
  echo -e "  ${DIM}These seed the knowledge graph. Be descriptive — this is who they are.${NC}"
  echo ""
  read -p "  One-line vibe (e.g. \"curious alien fascinated by human culture\"): " VIBE
  read -p "  Communication style (e.g. \"warm and direct, asks real questions\"): " COMM_STYLE
  read -p "  Any notable traits or quirks? (optional): " QUIRKS
  read -p "  Interests / expertise (comma-separated, optional): " INTERESTS_RAW
fi

# ── Step 3: Access ─────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Access Control ────────────────────────────────────────${NC}"
echo ""

if [ "$QUICK_MODE" = "true" ]; then
  DM_POLICY="pairing"
  echo -e "  ${DIM}DM policy: pairing (default)${NC}"
else
  echo "  DM policy:"
  echo "    1) pairing  — stranger gets a code, you approve  ${DIM}(recommended)${NC}"
  echo "    2) open     — anyone can DM"
  echo "    3) allowlist — only IDs you specify"
  read -p "  Choice [1]: " DM_POLICY_CHOICE
  case "$DM_POLICY_CHOICE" in
    2) DM_POLICY="open" ;;
    3) DM_POLICY="allowlist" ;;
    *) DM_POLICY="pairing" ;;
  esac
fi

# ── Step 3b: Capabilities ──────────────────────────────────────────

echo ""
echo -e "${BOLD}── Capabilities ──────────────────────────────────────────${NC}"
echo ""

WEB_PORT=""
INGRESS_MODE="none"
INGRESS_DOMAIN=""
INGRESS_PATH=""   # set after AGENT_ID placeholder fix
INGRESS_HTTPS="false"

WEB_HOSTING_INPUT="N"
if [ "$QUICK_MODE" = "true" ]; then
  WEB_HOSTING_INPUT="Y"
  echo -e "  ${DIM}Web hosting: enabled (default in quick mode)${NC}"
elif [ "$ANIMA_IS_LOCAL" = "true" ]; then
  read -p "  Enable web hosting? (agent can serve websites) [Y/n]: " WEB_HOSTING_INPUT
  [[ -z "$WEB_HOSTING_INPUT" ]] && WEB_HOSTING_INPUT="Y"
else
  read -p "  Enable web hosting? (agent can serve websites) [y/N]: " WEB_HOSTING_INPUT
fi
if [[ "$WEB_HOSTING_INPUT" =~ ^[Yy]$ ]]; then

  # Auto-pick a web port starting at 18800
  WEB_PORT_DEFAULT=18800
  while true; do
    PORT_USED=false
    for f in "$ANIMAS_DIR"/*/docker-compose.yml; do
      [ -f "$f" ] || continue
      grep -q ":-${WEB_PORT_DEFAULT}}" "$f" 2>/dev/null && PORT_USED=true && break
    done
    $PORT_USED && WEB_PORT_DEFAULT=$((WEB_PORT_DEFAULT + 1)) || break
  done

  if [ "$QUICK_MODE" = "true" ]; then
    WEB_PORT="$WEB_PORT_DEFAULT"
    echo -e "  ${DIM}Web port: ${WEB_PORT}${NC}"
  else
    read -p "  Web port [${WEB_PORT_DEFAULT}]: " WEB_PORT_INPUT
    WEB_PORT="${WEB_PORT_INPUT:-$WEB_PORT_DEFAULT}"
  fi

  WEB_AUTH_USER=""
  WEB_AUTH_PASS=""
  if [ "$QUICK_MODE" != "true" ]; then
    echo ""
    echo -e "    ${CYAN}1)${NC} Public   — anyone can view"
    echo -e "    ${CYAN}2)${NC} Private  — require username/password"
    read -p "  Access [1]: " WEB_AUTH_CHOICE
    if [ "$WEB_AUTH_CHOICE" = "2" ]; then
      read -p "  Username: " WEB_AUTH_USER
      read -sp "  Password: " WEB_AUTH_PASS
      echo ""
      if [ -z "$WEB_AUTH_USER" ] || [ -z "$WEB_AUTH_PASS" ]; then
        echo -e "  ${YELLOW}Empty credentials — web will be public.${NC}"
        WEB_AUTH_USER=""
        WEB_AUTH_PASS=""
      fi
    fi
  fi

  # Ingress: skip entirely in local mode
  if [ "$ANIMA_IS_LOCAL" != "true" ] && [ "$QUICK_MODE" != "true" ]; then
  TRAEFIK_DOMAIN_DEFAULT=""
  TRAEFIK_HTTPS_DEFAULT="true"
  TRAEFIK_RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i traefik | head -1 || true)
  if [ -f "$TRAEFIK_ENV" ]; then
    TRAEFIK_DOMAIN_DEFAULT=$(grep "^TRAEFIK_DOMAIN=" "$TRAEFIK_ENV" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
    TRAEFIK_HTTPS_DEFAULT=$(grep "^TRAEFIK_HTTPS=" "$TRAEFIK_ENV" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
    [ -z "$TRAEFIK_HTTPS_DEFAULT" ] && TRAEFIK_HTTPS_DEFAULT="true"
  fi

  echo ""
  if [ -n "$TRAEFIK_RUNNING" ] || [ -n "$TRAEFIK_DOMAIN_DEFAULT" ]; then
    # Traefik is available — offer it as the default
    DOMAIN_HINT=""
    [ -n "$TRAEFIK_DOMAIN_DEFAULT" ] && DOMAIN_HINT=" (${TRAEFIK_DOMAIN_DEFAULT}/animas/AGENT_PLACEHOLDER)"
    read -p "  Route via Traefik${DOMAIN_HINT}? [Y/n]: " INGRESS_TRAEFIK_INPUT
    if [[ ! "$INGRESS_TRAEFIK_INPUT" =~ ^[Nn]$ ]]; then
      INGRESS_MODE="traefik"
    fi
  else
    # No Traefik detected — offer the option but don't assume
    read -p "  Route via Traefik (domain/path ingress)? [y/N]: " INGRESS_TRAEFIK_INPUT
    [[ "$INGRESS_TRAEFIK_INPUT" =~ ^[Yy]$ ]] && INGRESS_MODE="traefik"
  fi

  if [ "$INGRESS_MODE" = "traefik" ]; then
    if [ -n "$TRAEFIK_DOMAIN_DEFAULT" ]; then
      read -p "  Domain [${TRAEFIK_DOMAIN_DEFAULT}]: " DOMAIN_INPUT
      INGRESS_DOMAIN="${DOMAIN_INPUT:-$TRAEFIK_DOMAIN_DEFAULT}"
    else
      echo ""
      echo -e "  ${DIM}Don't have a domain yet? Enter one anyway — we'll check if DNS is set up.${NC}"
      read -p "  Domain (e.g. 2peracent.ai): " INGRESS_DOMAIN
    fi

    if [ -n "$INGRESS_DOMAIN" ] && type check_domain_dns &>/dev/null; then
      check_domain_dns "$INGRESS_DOMAIN"
      DNS_RESULT=$?
      if [ "$DNS_RESULT" = "2" ]; then
        echo -e "  ${DIM}Ingress skipped. You can configure it later with ./configure-anima.sh${NC}"
        INGRESS_MODE="none"
      fi
    fi

    if [ "$INGRESS_MODE" = "traefik" ]; then
      INGRESS_PATH="/animas/AGENT_PLACEHOLDER"
      read -p "  Path [/animas/AGENT_PLACEHOLDER]: " PATH_INPUT
      [ -n "$PATH_INPUT" ] && INGRESS_PATH="$PATH_INPUT"
      [[ "$INGRESS_PATH" != /* ]] && INGRESS_PATH="/${INGRESS_PATH}"
      DEFAULT_HTTPS="Y"; [ "$TRAEFIK_HTTPS_DEFAULT" = "false" ] && DEFAULT_HTTPS="N"
      read -p "  HTTPS via Let's Encrypt? [${DEFAULT_HTTPS}]: " HTTPS_INPUT
      HTTPS_INPUT="${HTTPS_INPUT:-$DEFAULT_HTTPS}"
      [[ "$HTTPS_INPUT" =~ ^[Yy]$ ]] && INGRESS_HTTPS="true" || INGRESS_HTTPS="false"

      if [ -z "$TRAEFIK_RUNNING" ] && [ -z "$TRAEFIK_DOMAIN_DEFAULT" ]; then
        echo ""
        echo -e "  ${YELLOW}Note: Traefik doesn't appear to be running.${NC}"
        echo -e "  ${DIM}  Run ./setup-traefik.sh before starting this agent.${NC}"
      fi
    fi
  fi
  fi # end of ANIMA_IS_LOCAL != true guard

fi

HOST_ACCESS=false
HOST_PATHS=""
PERSONALITY_EDITABLE=true
SRC_EDITABLE=false
PROACTIVE_ENABLED=false

if [ "$QUICK_MODE" = "true" ]; then
  echo -e "  ${DIM}Using default permissions (quick mode).${NC}"
else
  echo ""
  echo -e "  ${DIM}Host read access — mounts host paths into the container read-only.${NC}"
  echo -e "  ${YELLOW}⚠  WARNING: The agent can read any file in the mounted paths.${NC}"
  read -p "  Grant host filesystem read access? [y/N]: " HOST_ACCESS_INPUT
  if [[ "$HOST_ACCESS_INPUT" =~ ^[Yy]$ ]]; then
    HOST_ACCESS=true
    read -p "  Host paths to mount (comma-separated) [/mnt/disk]: " HOST_PATHS_INPUT
    HOST_PATHS="${HOST_PATHS_INPUT:-/mnt/disk}"
  fi

  echo ""
  echo -e "${BOLD}── Agent permissions ──────────────────────────────────────${NC}"
  echo ""
  echo -e "  ${DIM}The agent always has full read/write access to its knowledge graph${NC}"
  echo -e "  ${DIM}for learning facts, storing memories, and building relationships.${NC}"
  echo ""
  echo -e "  ${DIM}Personality editing lets the agent change its own identity, voice,${NC}"
  echo -e "  ${DIM}and rules. Disable to keep the personality you configured above.${NC}"
  read -p "  Can the agent modify its own personality? [Y/n]: " PERSONALITY_EDITABLE_INPUT
  [[ "$PERSONALITY_EDITABLE_INPUT" =~ ^[Nn]$ ]] && PERSONALITY_EDITABLE=false

  echo ""
  echo -e "  ${DIM}Source editing bind-mounts src/ so the agent can modify its own code.${NC}"
  echo -e "  ${YELLOW}⚠  This lets the agent permanently alter its own behavior.${NC}"
  read -p "  Can the agent modify its own source code? [y/N]: " SRC_EDITABLE_INPUT
  [[ "$SRC_EDITABLE_INPUT" =~ ^[Yy]$ ]] && SRC_EDITABLE=true

  echo ""
  echo -e "  ${DIM}Proactive outreach lets the agent occasionally share interesting${NC}"
  echo -e "  ${DIM}things it learned during maintenance. Very selective — most cycles${NC}"
  echo -e "  ${DIM}produce no message. Configurable cooldown (default 3h) and daily cap (3).${NC}"
  read -p "  Enable proactive outreach? [y/N]: " PROACTIVE_INPUT
  [[ "$PROACTIVE_INPUT" =~ ^[Yy]$ ]] && PROACTIVE_ENABLED=true
fi

# ── Voice pipeline (optional) ─────────────────────────────────────

VOICE_DEEPGRAM_KEY=""
VOICE_XI_KEY=""
VOICE_OPENAI_KEY=""
VOICE_TTS_PROVIDER=""
VOICE_TTS_VOICE=""
VOICE_TTS_EDGE_VOICE=""
VOICE_ENABLED=false
VOICE_SETUP_INPUT="N"

if [ "$QUICK_MODE" != "true" ]; then
echo ""
echo -e "${BOLD}── Voice Pipeline (optional) ──────────────────────────────${NC}"
echo ""
echo -e "  ${DIM}Voice lets your agent respond with speech in Discord voice${NC}"
echo -e "  ${DIM}channels and Telegram voice notes.${NC}"
echo ""
read -p "  Configure voice pipeline? [y/N]: " VOICE_SETUP_INPUT
fi

if [[ "$VOICE_SETUP_INPUT" =~ ^[Yy]$ ]]; then
  echo ""
  echo -e "  ${BOLD}Speech-to-Text (STT)${NC}"
  echo -e "  ${DIM}Deepgram is recommended. Free tier: 45 hours/month.${NC}"
  echo -e "  ${DIM}Get a key at: https://console.deepgram.com${NC}"
  echo ""
  read -p "  Deepgram API key: " VOICE_DEEPGRAM_KEY

  echo ""
  echo -e "  ${BOLD}Text-to-Speech (TTS)${NC}"
  echo ""
  echo -e "    ${CYAN}1)${NC} Edge TTS      — ${GREEN}free${NC}, no API key, Microsoft neural voices"
  echo -e "    ${CYAN}2)${NC} ElevenLabs    — highest quality, voice cloning (paid, XI_API_KEY)"
  echo -e "    ${CYAN}3)${NC} OpenAI TTS    — good quality, simple (paid, OPENAI_API_KEY)"
  echo ""
  read -p "  TTS provider [1]: " TTS_CHOICE_INPUT
  TTS_CHOICE="${TTS_CHOICE_INPUT:-1}"

  case "$TTS_CHOICE" in
    2)
      VOICE_TTS_PROVIDER="elevenlabs"
      read -p "  ElevenLabs API key: " VOICE_XI_KEY
      echo -e "  ${DIM}Voice ID (e.g. JBFqnCBsd6RMkjVDRZzb for George)${NC}"
      read -p "  Voice ID (blank=default): " VOICE_TTS_VOICE
      ;;
    3)
      VOICE_TTS_PROVIDER="openai"
      read -p "  OpenAI API key: " VOICE_OPENAI_KEY
      echo -e "  ${DIM}Voice: alloy, echo, fable, onyx, nova, shimmer${NC}"
      read -p "  Voice name [alloy]: " VOICE_TTS_VOICE
      ;;
    *)
      VOICE_TTS_PROVIDER="edge"
      echo -e "  ${DIM}Popular voices: en-US-AriaNeural, en-US-GuyNeural,${NC}"
      echo -e "  ${DIM}en-US-JennyNeural, en-GB-SoniaNeural, en-AU-NatashaNeural${NC}"
      read -p "  Edge voice [en-US-AriaNeural]: " VOICE_TTS_EDGE_VOICE
      ;;
  esac

  # Enable voice if STT key is set (TTS always has Edge fallback)
  [ -n "$VOICE_DEEPGRAM_KEY" ] && VOICE_ENABLED=true
fi

# ── Slack (optional) ──────────────────────────────────────────────

SLACK_BOT_TOKEN=""
SLACK_APP_TOKEN=""

if [ "$QUICK_MODE" != "true" ]; then
  echo ""
  echo -e "${BOLD}── Slack (optional) ──────────────────────────────────────${NC}"
  echo ""
  echo -e "  ${DIM}Requires a Slack app with Socket Mode enabled.${NC}"
  echo -e "  ${DIM}Create one at: https://api.slack.com/apps${NC}"
  echo ""
  read -p "  Slack Bot Token (xoxb-…) [blank to skip]: " SLACK_BOT_TOKEN
  if [ -n "$SLACK_BOT_TOKEN" ]; then
    echo -e "  ${DIM}App Token — from your app's Socket Mode settings page.${NC}"
    read -p "  Slack App Token (xapp-…): " SLACK_APP_TOKEN
    if [ -z "$SLACK_APP_TOKEN" ]; then
      echo -e "  ${YELLOW}App Token required for Socket Mode — Slack will be skipped.${NC}"
      SLACK_BOT_TOKEN=""
    fi
  fi
fi

# Resolve AGENT_PLACEHOLDER now that AGENT_ID is known and capabilities are set
INGRESS_PATH="${INGRESS_PATH//AGENT_PLACEHOLDER/$AGENT_ID}"

PORT_INPUT=""
if [ "$QUICK_MODE" != "true" ]; then
  read -p "  Health check port [auto]: " PORT_INPUT
fi
if [ -n "$PORT_INPUT" ]; then
  PORT="$PORT_INPUT"
elif [ -n "$PORT_ARG" ]; then
  PORT="$PORT_ARG"
else
  PORT=18790
  while true; do
    USED=false
    for f in "$ANIMAS_DIR"/*/docker-compose.yml; do
      [ -f "$f" ] || continue
      grep -q ":-${PORT}}" "$f" 2>/dev/null && USED=true && break
    done
    $USED && PORT=$((PORT + 1)) || break
  done
fi

# ── Step 3b: Local Models (Ollama) ─────────────────────────────────

USE_LOCAL_LEARNER=false
OLLAMA_LEARNER_MODEL=""

if [ "$QUICK_MODE" != "true" ]; then
echo ""
echo -e "${BOLD}── Local Models (Ollama) ─────────────────────────────────${NC}"
echo ""
fi

if command -v ollama &>/dev/null; then
  echo -e "  ${GREEN}Ollama is installed.${NC}"
  if curl -s http://localhost:11434/api/version &>/dev/null; then
    echo -e "  ${GREEN}Ollama is running.${NC}"
    EXISTING=$(curl -s http://localhost:11434/api/tags 2>/dev/null | grep -oP '"name"\s*:\s*"\K[^"]+' | head -10)
    if [ -n "$EXISTING" ]; then
      echo -e "  ${DIM}Installed models: ${EXISTING//$'\n'/, }${NC}"
    fi
  else
    echo -e "  ${YELLOW}Ollama is installed but not running.${NC}"
    read -p "  Start Ollama? [y/N]: " START_OLLAMA
    if [[ "$START_OLLAMA" =~ ^[Yy] ]]; then
      echo "  Starting Ollama..."
      systemctl start ollama 2>/dev/null || (ollama serve &>/dev/null &)
      sleep 2
    fi
  fi
else
  echo -e "  ${DIM}Ollama is not installed. You can install it later from the Manager UI.${NC}"
  read -p "  Install Ollama now? [y/N]: " INSTALL_OLLAMA
  if [[ "$INSTALL_OLLAMA" =~ ^[Yy] ]]; then
    echo "  Installing Ollama (this may take a moment)..."
    curl -fsSL https://ollama.com/install.sh | sh
    systemctl start ollama 2>/dev/null || (ollama serve &>/dev/null &)
    sleep 2
  fi
fi

if command -v ollama &>/dev/null && curl -s http://localhost:11434/api/version &>/dev/null; then
  echo ""
  echo -e "  ${DIM}Use a local model for the learner? (free, but slower on CPU)${NC}"
  echo -e "  ${DIM}Recommended: qwen3.5:9b (~6GB RAM), qwen3.5:4b (~3GB RAM)${NC}"
  echo -e "  ${DIM}Leave blank to use Anthropic Haiku (default, fast, ~\$0.001/extraction)${NC}"
  read -p "  Local learner model [blank = haiku]: " LOCAL_LEARNER_INPUT
  if [ -n "$LOCAL_LEARNER_INPUT" ]; then
    OLLAMA_LEARNER_MODEL="$LOCAL_LEARNER_INPUT"
    USE_LOCAL_LEARNER=true
    # Pull the model if not already available
    if ! ollama list 2>/dev/null | grep -q "$OLLAMA_LEARNER_MODEL"; then
      echo -e "  ${CYAN}Pulling ${OLLAMA_LEARNER_MODEL}... this may take a while.${NC}"
      ollama pull "$OLLAMA_LEARNER_MODEL" || echo -e "  ${RED}Pull failed — you can pull it later.${NC}"
    else
      echo -e "  ${GREEN}Model ${OLLAMA_LEARNER_MODEL} already available.${NC}"
    fi
  fi
fi

# ── Step 4: Starting point ─────────────────────────────────────────

COPY_GRAPH=false
FROM_DIR=""

if [ "$QUICK_MODE" = "true" ]; then
  echo -e "  ${DIM}Starting fresh (quick mode).${NC}"
else

echo ""
echo -e "${BOLD}── Starting Point ────────────────────────────────────────${NC}"
echo ""
fi

# List existing agents for cloning
EXISTING_ANIMAS=()
for d in "$ANIMAS_DIR"/*/; do
  name=$(basename "$d")
  [[ "$name" == .* ]] && continue
  [ -d "$d/src" ] && EXISTING_ANIMAS+=("$name")
done

if [ "$QUICK_MODE" = "true" ] && [ -z "$FROM_ARG" ]; then
  true  # skip interactive clone selection
elif [ -n "$FROM_ARG" ]; then
  # Specified via --from flag
  FROM_DIR="$ANIMAS_DIR/$FROM_ARG"
  if [ ! -d "$FROM_DIR/src" ]; then
    echo -e "${YELLOW}  Warning: \"$FROM_ARG\" has no src/ — using base source instead.${NC}"
    FROM_DIR=""
  else
    echo -e "  ${DIM}Duplicating from: ${FROM_ARG}${NC}"
    if [ -f "$FROM_DIR/data/graph.db" ]; then
      read -p "  Also copy ${FROM_ARG}'s knowledge graph? [y/N]: " COPY_GRAPH_INPUT
      [[ "$COPY_GRAPH_INPUT" =~ ^[Yy]$ ]] && COPY_GRAPH=true
    fi
  fi
elif [ ${#EXISTING_ANIMAS[@]} -gt 0 ]; then
  echo -e "  ${CYAN}1)${NC} Fresh start    — base source code, empty graph"
  echo -e "  ${CYAN}2)${NC} Clone existing — copy source + optionally graph from another ${BRAND_AGENT}"
  read -p "  Choice [1]: " CLONE_CHOICE

  if [ "$CLONE_CHOICE" = "2" ]; then
    echo ""
    echo -e "  Available ${BRAND_AGENTS} to clone from:"
    for a in "${EXISTING_ANIMAS[@]}"; do
      echo -e "    ${CYAN}${a}${NC}"
    done
    echo ""
    read -p "  Clone from: " CLONE_SOURCE
    if [ -n "$CLONE_SOURCE" ] && [ -d "$ANIMAS_DIR/$CLONE_SOURCE/src" ]; then
      FROM_DIR="$ANIMAS_DIR/$CLONE_SOURCE"
      FROM_ARG="$CLONE_SOURCE"
      echo ""
      echo -e "  ${CYAN}a)${NC} Source only  — same code, fresh empty graph"
      echo -e "  ${CYAN}b)${NC} Source + graph — everything including memories and relationships"
      read -p "  What to copy? [a]: " COPY_WHAT
      [[ "$COPY_WHAT" =~ ^[Bb]$ ]] && COPY_GRAPH=true
    else
      echo -e "${YELLOW}  Not found — starting fresh.${NC}"
    fi
  fi
else
  echo -e "  ${DIM}Starting fresh — base source code, empty graph.${NC}"
fi

# ── Build seed SQL ─────────────────────────────────────────────────

# Format nicknames as JSON array
NICKNAMES_JSON="["
IFS=',' read -ra NICK_ARR <<< "$NICKNAMES_RAW"
FIRST=true
for NICK in "${NICK_ARR[@]}"; do
  NICK_TRIMMED=$(echo "$NICK" | xargs | tr '[:upper:]' '[:lower:]')
  [ -z "$NICK_TRIMMED" ] && continue
  $FIRST || NICKNAMES_JSON+=", "
  NICKNAMES_JSON+="\"$NICK_TRIMMED\""
  FIRST=false
done
NICKNAMES_JSON+="]"

# Build interests list
INTERESTS_TEXT=""
if [ -n "$INTERESTS_RAW" ]; then
  INTERESTS_TEXT="Interests and expertise: ${INTERESTS_RAW}."
fi

QUIRKS_TEXT=""
if [ -n "$QUIRKS" ]; then
  QUIRKS_TEXT="$QUIRKS"
fi

# ── Ensure shared directories ──────────────────────────────────────

mkdir -p "$SCRIPT_DIR/shared/skills" "$SCRIPT_DIR/shared/graphs"
if getent group 2000 &>/dev/null; then
  chgrp -R 2000 "$SCRIPT_DIR/shared" 2>/dev/null || true
  chmod 2775 "$SCRIPT_DIR/shared" "$SCRIPT_DIR/shared/skills" "$SCRIPT_DIR/shared/graphs" 2>/dev/null || true
fi

# ── Create directories ─────────────────────────────────────────────

echo -e "${CYAN}  Creating ${AGENT_ID}...${NC}"
mkdir -p "$AGENT_DIR/data" "$AGENT_DIR/workspace/web" "$AGENT_DIR/workspace/plugins" "$AGENT_DIR/static"
cp "$SCRIPT_DIR/src/static/graph-viewer.html" "$AGENT_DIR/static/"
cp "$SCRIPT_DIR/src/static/brand.js" "$AGENT_DIR/static/" 2>/dev/null || true
cp "$SCRIPT_DIR/brand.json" "$AGENT_DIR/brand.json" 2>/dev/null || true

# ── Copy source files ──────────────────────────────────────────────

BASE_SRC="$SCRIPT_DIR/src"

if [ -n "$FROM_DIR" ] && [ -d "$FROM_DIR/src" ]; then
  cp -r "$FROM_DIR/src/." "$AGENT_DIR/src/"
  echo -e "${GREEN}  ✓ Source duplicated from ${FROM_ARG} (${BRAND_AGENT} clone)${NC}"
else
  cp -r "$BASE_SRC" "$AGENT_DIR/src"
  rm -rf "$AGENT_DIR/src/node_modules" 2>/dev/null || true
  cp "$TEMPLATE_DIR/src/Dockerfile" "$AGENT_DIR/src/Dockerfile"
  echo -e "${GREEN}  ✓ Source copied from base${NC}"
fi

# Copy graph if requested
if $COPY_GRAPH && [ -n "$FROM_DIR" ] && [ -f "$FROM_DIR/data/graph.db" ]; then
  cp "$FROM_DIR/data/graph.db" "$AGENT_DIR/data/graph.db"
  cp "$FROM_DIR/data/graph.db-shm" "$AGENT_DIR/data/" 2>/dev/null || true
  cp "$FROM_DIR/data/graph.db-wal" "$AGENT_DIR/data/" 2>/dev/null || true
  echo -e "${GREEN}  ✓ Graph copied from ${FROM_ARG}${NC}"
  # Update the agent ID in the copied graph (SQL-escape single quotes)
  if command -v sqlite3 &>/dev/null; then
    SAFE_NAME="${DISPLAY_NAME//\'/\'\'}"
    SAFE_FROM="${FROM_ARG//\'/\'\'}"
    SAFE_ID="${AGENT_ID//\'/\'\'}"
    sqlite3 "$AGENT_DIR/data/graph.db" "UPDATE nodes SET id='${SAFE_ID}', label='${SAFE_NAME}', updated=datetime('now') WHERE id='${SAFE_FROM}';" 2>/dev/null || true
    sqlite3 "$AGENT_DIR/data/graph.db" "UPDATE aspects SET node_id='${SAFE_ID}' WHERE node_id='${SAFE_FROM}';" 2>/dev/null || true
    sqlite3 "$AGENT_DIR/data/graph.db" "UPDATE edges SET source='${SAFE_ID}' WHERE source='${SAFE_FROM}';" 2>/dev/null || true
    sqlite3 "$AGENT_DIR/data/graph.db" "UPDATE edges SET target='${SAFE_ID}' WHERE target='${SAFE_FROM}';" 2>/dev/null || true
    sqlite3 "$AGENT_DIR/data/graph.db" "UPDATE aliases SET node_id='${SAFE_ID}' WHERE node_id='${SAFE_FROM}';" 2>/dev/null || true
    echo -e "${GREEN}  ✓ Graph identity updated to ${AGENT_ID}${NC}"
  fi
fi

# ── Write anima.json ───────────────────────────────────────────────

cat > "$AGENT_DIR/anima.json" << ANIMAJSON
{
  "agentId": "${AGENT_ID}",
  "displayName": "${DISPLAY_NAME}",
  "nicknames": ${NICKNAMES_JSON},
  "guilds": {},
  "privacy": {
    "default": {
      "private": false,
      "learn": true,
      "shareToFeed": true,
      "respond": true
    }
  },
  "channels": {
    "telegram": {
      "enabled": false,
      "dmPolicy": "${DM_POLICY}",
      "groupPolicy": "open",
      "requireMention": true
    },
    "slack": {
      "enabled": false,
      "requireMention": true,
      "textChunkLimit": 3000,
      "dmPolicy": "open"
    }
  }
}
ANIMAJSON

# ── Write .env ─────────────────────────────────────────────────────

cat > "$AGENT_DIR/.env" << ENV
DISCORD_TOKEN=
ANTHROPIC_API_KEY=
AGENT_ID=${AGENT_ID}
ANIMA_DISPLAY_NAME=${DISPLAY_NAME}
ANIMA_CASUAL_MODEL=claude-haiku-4-5
ANIMA_NORMAL_MODEL=claude-sonnet-4-6
ANIMA_PLANNER_MODEL=claude-opus-4-6
ANIMA_SUBAGENT_MODEL=claude-sonnet-4-6
ANIMA_HEALTH_PORT=${PORT}
ANIMA_LOG_LEVEL=info

# Optional
BRAVE_API_KEY=
GEMINI_API_KEY=
TELEGRAM_BOT_TOKEN=
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN:-}
ENV

# Append web port if set
if [ -n "$WEB_PORT" ]; then
  echo "ANIMA_WEB_PORT=${WEB_PORT}" >> "$AGENT_DIR/.env"
fi

# Append host read paths if set
if $HOST_ACCESS && [ -n "$HOST_PATHS" ]; then
  echo "ANIMA_HOST_READ_PATHS=${HOST_PATHS}" >> "$AGENT_DIR/.env"
fi

# Append web auth credentials
if [ -n "$WEB_AUTH_USER" ] && [ -n "$WEB_AUTH_PASS" ]; then
  echo "ANIMA_WEB_AUTH_USER=${WEB_AUTH_USER}" >> "$AGENT_DIR/.env"
  echo "ANIMA_WEB_AUTH_PASS=${WEB_AUTH_PASS}" >> "$AGENT_DIR/.env"
fi

# Append personality editable flag
if $PERSONALITY_EDITABLE; then
  echo "ANIMA_PERSONALITY_EDITABLE=true" >> "$AGENT_DIR/.env"
fi

# Append src editable flag
if $SRC_EDITABLE; then
  echo "ANIMA_SRC_EDITABLE=true" >> "$AGENT_DIR/.env"
fi

# Append proactive outreach flag
if $PROACTIVE_ENABLED; then
  echo "ANIMA_PROACTIVE_ENABLED=true" >> "$AGENT_DIR/.env"
fi


# Append ingress config if set
if [ "$INGRESS_MODE" = "traefik" ]; then
  {
    echo "ANIMA_INGRESS_MODE=traefik"
    echo "ANIMA_INGRESS_DOMAIN=${INGRESS_DOMAIN}"
    echo "ANIMA_INGRESS_PATH=${INGRESS_PATH}"
    echo "ANIMA_INGRESS_HTTPS=${INGRESS_HTTPS}"
  } >> "$AGENT_DIR/.env"
fi

# Append voice pipeline config if set
if $VOICE_ENABLED; then
  {
    echo ""
    echo "# Voice pipeline"
    echo "ANIMA_VOICE_ENABLED=true"
    [ -n "$VOICE_DEEPGRAM_KEY" ] && echo "DEEPGRAM_API_KEY=${VOICE_DEEPGRAM_KEY}"
    [ -n "$VOICE_XI_KEY" ] && echo "XI_API_KEY=${VOICE_XI_KEY}"
    [ -n "$VOICE_OPENAI_KEY" ] && echo "OPENAI_API_KEY=${VOICE_OPENAI_KEY}"
    [ -n "$VOICE_TTS_PROVIDER" ] && echo "ANIMA_TTS_PROVIDER=${VOICE_TTS_PROVIDER}"
    [ -n "$VOICE_TTS_VOICE" ] && echo "ANIMA_TTS_VOICE=${VOICE_TTS_VOICE}"
    [ -n "$VOICE_TTS_EDGE_VOICE" ] && echo "ANIMA_TTS_EDGE_VOICE=${VOICE_TTS_EDGE_VOICE}"
  } >> "$AGENT_DIR/.env"
fi

# Always append context/learning defaults
{
  echo ""
  echo "# Context & Learning"
  if $USE_LOCAL_LEARNER && [ -n "$OLLAMA_LEARNER_MODEL" ]; then
    echo "ANIMA_LEARNER_MODEL=local/${OLLAMA_LEARNER_MODEL}"
    echo "LOCAL_MODEL_BASE_URL=http://host.docker.internal:11434/v1"
  else
    echo "ANIMA_LEARNER_MODEL=claude-haiku-4-5"
  fi
  echo "ANIMA_LEARNING_MODE=always"
  echo "ANIMA_CONTEXT_WINDOW=200000"
  echo "ANIMA_COMPACT_THRESHOLD=80000"
  echo "ANIMA_COMPACT_KEEP_TAIL=20"
  echo "ANIMA_MAINTAINER_IDLE_ONLY=true"
} >> "$AGENT_DIR/.env"

# ── Bare mode: host-path .env additions + run.sh ─────────────────

if [ "$BARE_MODE" = "true" ]; then
  # Add host-path-specific env vars
  {
    echo ""
    echo "# Bare mode paths"
    echo "GRAPH_DB_PATH=$AGENT_DIR/data/graph.db"
    echo "SESSION_DB_PATH=$AGENT_DIR/data/sessions.db"
    echo "ANIMA_WORKSPACE_PATH=$AGENT_DIR/workspace"
    echo "SHARED_SKILLS_DIR=$SCRIPT_DIR/shared/skills"
    echo "SHARED_GRAPHS_DIR=$SCRIPT_DIR/shared/graphs"
  } >> "$AGENT_DIR/.env"

  # Read manager config if available
  MGR_ENV="$SCRIPT_DIR/manager/.env"
  if [ -f "$MGR_ENV" ]; then
    MGR_KEY=$(grep '^MANAGER_SERVICE_KEY=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)
    MGR_PORT=$(grep '^MANAGER_PORT=' "$MGR_ENV" 2>/dev/null | cut -d= -f2)
    MGR_PORT="${MGR_PORT:-18900}"
    if [ -n "$MGR_KEY" ]; then
      {
        echo ""
        echo "# Manager connection"
        echo "MANAGER_URL=http://127.0.0.1:${MGR_PORT}"
        echo "MANAGER_SERVICE_KEY=${MGR_KEY}"
      } >> "$AGENT_DIR/.env"
    fi
  fi

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

  # Generate run.sh
  cat > "$AGENT_DIR/run.sh" << RUNEOF
#!/bin/bash
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
set -a; source "\$SCRIPT_DIR/.env" 2>/dev/null; set +a
cd "$SCRIPT_DIR/src"
exec "$NODE_BIN" index.js
RUNEOF
  chmod +x "$AGENT_DIR/run.sh"
  echo -e "${GREEN}  ✓ run.sh generated${NC}"

  # Seed graph
  echo -e "  ${CYAN}Seeding knowledge graph...${NC}"
  SEED_SQL="$AGENT_DIR/src/seed-graph.sql"
  [ ! -f "$SEED_SQL" ] && SEED_SQL="$SCRIPT_DIR/src/seed-graph.sql"
  DATA_DIR="$AGENT_DIR/data"
  mkdir -p "$DATA_DIR"

  if [ -f "$SEED_SQL" ] && [ ! -f "$DATA_DIR/graph.db" ]; then
    SEED_TEMP=$(mktemp)
    SEED_JS=$(mktemp --suffix=.mjs 2>/dev/null || mktemp)
    sed "s/AGENT_ID/${AGENT_ID}/g; s/AGENT_NAME/${DISPLAY_NAME}/g" "$SEED_SQL" > "$SEED_TEMP"
    cat > "$SEED_JS" << SEEDEOF
const{DatabaseSync}=require('node:sqlite');
const fs=require('fs');
const db=new DatabaseSync(process.argv[2]);
db.exec(fs.readFileSync(process.argv[3],'utf8'));
db.close();
SEEDEOF
    "$NODE_BIN" "$SEED_JS" "$DATA_DIR/graph.db" "$SEED_TEMP" 2>/dev/null || \
      echo -e "  ${YELLOW}⚠  Graph seed failed — will be created on first run.${NC}"
    rm -f "$SEED_TEMP" "$SEED_JS"
  fi
  echo -e "${GREEN}  ✓ Knowledge graph seeded${NC}"

  # Set permissions
  chown -R "$(id -u):$(id -g)" "$AGENT_DIR" 2>/dev/null || true
  echo -e "${GREEN}  ✓ Permissions set${NC}"

  # Done
  echo ""
  echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}  ║  ${GREEN}${DISPLAY_NAME}${NC}${BOLD} created!$(printf '%*s' $((32 - ${#DISPLAY_NAME})) '')║${NC}"
  echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${DIM}Location:    ${AGENT_DIR}${NC}"
  echo -e "  ${DIM}Health port: ${PORT}${NC}"
  [ -n "$WEB_PORT" ] && echo -e "  ${DIM}Web port:    ${WEB_PORT}${NC}"
  echo ""
  echo -e "${BOLD}Start:${NC}"
  echo -e "  ${CYAN}cd ${AGENT_DIR} && ./run.sh${NC}"
  echo ""
  [ -n "$WEB_PORT" ] && echo -e "  ${DIM}Web panel: http://localhost:${WEB_PORT}/graph${NC}"
  echo ""
  exit 0
fi

# ── Write docker-compose.yml ───────────────────────────────────────

# Build host volume mounts for docker-compose
HOST_VOLUMES=""
if $HOST_ACCESS && [ -n "$HOST_PATHS" ]; then
  BLOCKED_PATHS="/etc /root /home /var /proc /sys /dev /run /boot /usr /sbin /bin /lib /lib64 /tmp"
  IFS=',' read -ra HP_ARR <<< "$HOST_PATHS"
  for HP in "${HP_ARR[@]}"; do
    HP_TRIMMED=$(echo "$HP" | xargs)
    [ -z "$HP_TRIMMED" ] && continue
    HP_RESOLVED=$(realpath -m "$HP_TRIMMED" 2>/dev/null || echo "$HP_TRIMMED")
    BLOCKED=false
    for BP in $BLOCKED_PATHS; do
      if [[ "$HP_RESOLVED" = "$BP" || "$HP_RESOLVED" = "$BP/"* ]]; then
        echo -e "  ${RED}⚠  Blocked: ${HP_TRIMMED} — system path not allowed${NC}"
        BLOCKED=true; break
      fi
    done
    $BLOCKED && continue
    HOST_VOLUMES+="      - ${HP_RESOLVED}:/host${HP_RESOLVED}:ro"$'\n'
  done
fi

# Web port env (Traefik handles routing — no host port mapping needed)
WEB_PORT_ENV_LINE=""
if [ -n "$WEB_PORT" ]; then
  WEB_PORT_ENV_LINE="      - ANIMA_WEB_PORT=\${ANIMA_WEB_PORT:-${WEB_PORT}}"
  mkdir -p "$AGENT_DIR/workspace/web"
fi

# Src editable: bind-mount local src as /app (rw) + anonymous volume to preserve node_modules
# Non-editable: bind-mount shared base src dirs read-only so updates propagate automatically
SRC_VOLUMES=""
SRC_ENV_LINE=""
BUILD_SECTION=""
IMAGE_LINE=""
if $SRC_EDITABLE; then
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

# Traefik labels — always on, read domain from .ingress.json
TRAEFIK_LABELS=""
INGRESS_FILE="$SCRIPT_DIR/animas/.ingress.json"
INGRESS_DOMAIN=""
INGRESS_HTTPS="false"
if [ -f "$INGRESS_FILE" ] && command -v node &>/dev/null; then
  INGRESS_DOMAIN=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(j.domain||'')}catch{}" 2>/dev/null || true)
  INGRESS_HTTPS=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$INGRESS_FILE','utf8'));process.stdout.write(String(j.https||false))}catch{}" 2>/dev/null || true)
fi

if [ -n "$WEB_PORT" ]; then
  INGRESS_PATH="/animas/${AGENT_ID}"
  ROUTER="${AGENT_ID}"
  STRIP_MW="${AGENT_ID}-strip"
  ENTRYPOINT="web"
  TLS_LINES=""
  if [ "$INGRESS_HTTPS" = "true" ]; then
    ENTRYPOINT="websecure"
    TLS_LINES="      - \"traefik.http.routers.${ROUTER}.tls.certresolver=letsencrypt\""
  fi

  if [ -n "$INGRESS_DOMAIN" ]; then
    ROUTER_RULE="Host(\`${INGRESS_DOMAIN}\`) && PathPrefix(\`${INGRESS_PATH}/\`)"
  else
    ROUTER_RULE="PathPrefix(\`${INGRESS_PATH}/\`) || Path(\`${INGRESS_PATH}\`)"
  fi

  AUTH_MW=""
  AUTH_LABELS=""
  MIDDLEWARE_CHAIN="${STRIP_MW}"
  if [ -n "$WEB_AUTH_USER" ] && [ -n "$WEB_AUTH_PASS" ]; then
    AUTH_MW="${AGENT_ID}-auth"
    HTPASSWD_HASH=$(docker run --rm httpd:alpine htpasswd -nbB "$WEB_AUTH_USER" "$WEB_AUTH_PASS" 2>/dev/null || echo "")
    if [ -n "$HTPASSWD_HASH" ]; then
      HTPASSWD_ESCAPED=$(echo "$HTPASSWD_HASH" | sed 's/\$/\$\$/g')
      AUTH_LABELS="      - \"traefik.http.middlewares.${AUTH_MW}.basicauth.users=${HTPASSWD_ESCAPED}\""
      MIDDLEWARE_CHAIN="${STRIP_MW},${AUTH_MW}"
    fi
  fi

  TRAEFIK_LABELS="    labels:
      - \"traefik.enable=true\"
      - \"traefik.docker.network=anima-web\"
      - \"traefik.http.routers.${ROUTER}.rule=${ROUTER_RULE}\"
      - \"traefik.http.routers.${ROUTER}.priority=200\"
      - \"traefik.http.routers.${ROUTER}.entrypoints=${ENTRYPOINT}\"
${TLS_LINES}
      - \"traefik.http.services.${ROUTER}.loadbalancer.server.port=${WEB_PORT}\"
      - \"traefik.http.middlewares.${STRIP_MW}.stripprefix.prefixes=${INGRESS_PATH}\"
      - \"traefik.http.routers.${ROUTER}.middlewares=${MIDDLEWARE_CHAIN}\"
${AUTH_LABELS}"
fi

EXTRA_HOSTS="
    extra_hosts:
      - \"host.docker.internal:host-gateway\""

# SSH sidecar — skip if --no-sidecar, --local, or --quick
INCLUDE_SIDECAR=true
if [ "$SKIP_SIDECAR" = "true" ] || [ "$ANIMA_IS_LOCAL" = "true" ] || [ "$QUICK_MODE" = "true" ]; then
  INCLUDE_SIDECAR=false
fi
# Check if sidecar Dockerfile exists
if [ ! -f "$SCRIPT_DIR/sidecar/Dockerfile" ]; then
  INCLUDE_SIDECAR=false
fi

SIDECAR_VOLUME_LINE=""
SIDECAR_DEPENDS=""
SIDECAR_SERVICE=""
SIDECAR_VOLUME_DEF=""
if [ "$INCLUDE_SIDECAR" = "true" ]; then
  SIDECAR_VOLUME_LINE="      - ssh-sidecar-sock:/run/ssh-sidecar:ro"
  SIDECAR_DEPENDS="    depends_on:
      ssh-sidecar:
        condition: service_started"
  SIDECAR_SERVICE="  ssh-sidecar:
    build:
      context: ../../sidecar
      dockerfile: Dockerfile
    image: anima-ssh-sidecar:latest
    container_name: ${AGENT_ID}-ssh-sidecar
    restart: unless-stopped
    network_mode: \"none\"
    security_opt:
      - no-new-privileges:true
    environment:
      - SIDECAR_PASSPHRASE=\${ANIMA_WEB_AUTH_PASS:?Set ANIMA_WEB_AUTH_PASS in .env before starting}
      - SIDECAR_SOCKET=/run/ssh-sidecar/sidecar.sock
      - SIDECAR_STORE=/data/ssh-hosts.json
    volumes:
      - ssh-sidecar-sock:/run/ssh-sidecar
      - ./data:/data
    deploy:
      resources:
        limits:
          memory: 64M
    logging:
      driver: json-file
      options:
        max-size: \"5m\"
        max-file: \"2\""
  SIDECAR_VOLUME_DEF="volumes:
  ssh-sidecar-sock:"
fi

cat > "$AGENT_DIR/docker-compose.yml" << COMPOSE
services:
  anima:
${BUILD_SECTION}
${IMAGE_LINE}
    container_name: ${AGENT_ID}
    restart: unless-stopped
${EXTRA_HOSTS}
    env_file:
      - .env

    environment:
      - GRAPH_DB_PATH=/data/graph.db
      - SESSION_DB_PATH=/data/sessions.db
      - ANIMA_WORKSPACE_PATH=/workspace
      - SHARED_SKILLS_DIR=/shared/skills
      - SHARED_GRAPHS_DIR=/shared/graphs
      - ANIMA_LOG_LEVEL=\${ANIMA_LOG_LEVEL:-info}
      - ANIMA_HEALTH_PORT=\${ANIMA_HEALTH_PORT:-${PORT}}
${WEB_PORT_ENV_LINE}
${SRC_ENV_LINE}
    volumes:
      - ./data:/data
      - ./.env:/data/.env
      - ./anima.json:/app/anima.json:ro
      - ./brand.json:/app/brand.json:ro
      - ./workspace:/workspace
${SIDECAR_VOLUME_LINE}
      - ../../shared/skills:/shared/skills
      - ../../shared/graphs:/shared/graphs
${SRC_VOLUMES}${HOST_VOLUMES}
    ports:
      - "127.0.0.1:\${ANIMA_HEALTH_PORT:-${PORT}}:\${ANIMA_HEALTH_PORT:-${PORT}}"
    networks:
      - default
      - anima-web
${TRAEFIK_LABELS}
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 512M
    memswap_limit: 8G

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

    stop_grace_period: 10s
${SIDECAR_DEPENDS}

${SIDECAR_SERVICE}

${SIDECAR_VOLUME_DEF}

networks:
  anima-web:
    external: true
COMPOSE

# ── Default web page ───────────────────────────────────────────────

if [ -n "$WEB_PORT" ]; then
  WEB_DIR="$AGENT_DIR/workspace/web"
  WEB_INDEX="$WEB_DIR/index.html"
  mkdir -p "$WEB_DIR"
  if [ ! -f "$WEB_INDEX" ]; then
    cat > "$WEB_INDEX" << HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${DISPLAY_NAME}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;600;700&family=Space+Mono:wght@400;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0a; --surface: #111; --border: #1f1f1f;
      --accent: #7fff7f; --accent2: #4fd1c5; --text: #e8e8e8; --muted: #555;
    }
    body { background: var(--bg); color: var(--text); font-family: 'Space Grotesk', sans-serif;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { max-width: 560px; width: 100%; border: 1px solid var(--border); border-radius: 12px;
            padding: 3rem 3rem 2.5rem; background: var(--surface); position: relative; overflow: hidden; }
    .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
                    background: linear-gradient(90deg, var(--accent), var(--accent2)); }
    .status { display: inline-flex; align-items: center; gap: 0.5rem; font-family: 'Space Mono', monospace;
              font-size: 0.75rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 1.75rem; }
    .status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    h1 { font-size: 2.25rem; font-weight: 700; line-height: 1.15; margin-bottom: 1rem; letter-spacing: -0.02em; }
    .subtitle { color: var(--muted); font-size: 0.95rem; line-height: 1.6; margin-bottom: 2rem; }
    .hint { border-top: 1px solid var(--border); padding-top: 1.5rem; font-family: 'Space Mono', monospace;
            font-size: 0.75rem; color: var(--muted); line-height: 1.8; }
    .hint code { color: var(--accent2); }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">online</div>
    <h1>${DISPLAY_NAME}</h1>
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
    echo -e "${GREEN}  ✓ Default web page written${NC}"
  fi
fi

# ── Write seed-graph-custom.sql ────────────────────────────────────
# This overrides the base seed-graph.sql with personality info.
# The app.js boot process reads seed-graph.sql from the app dir.

VIBE_ESCAPED="${VIBE//\'/\'\'}"
COMM_ESCAPED="${COMM_STYLE//\'/\'\'}"
QUIRKS_ESCAPED="${QUIRKS_TEXT//\'/\'\'}"
INTERESTS_ESCAPED="${INTERESTS_TEXT//\'/\'\'}"
DISPLAY_ESCAPED="${DISPLAY_NAME//\'/\'\'}"
NICKNAMES_ESCAPED="${NICKNAMES_RAW//\'/\'\'}"

cp "$BASE_SRC/seed-graph.sql" "$AGENT_DIR/src/seed-graph.sql"

# Append personality seed to the agent's seed-graph.sql
cat >> "$AGENT_DIR/src/seed-graph.sql" << SEEDAPPEND


-- ═══════════════════════════════════════════════════════════════
-- PERSONALITY SEED (generated by new-agent.sh)
-- ═══════════════════════════════════════════════════════════════

-- Update agent description with display name and vibe
UPDATE nodes SET
  label = '${DISPLAY_ESCAPED}',
  description = '${DISPLAY_ESCAPED} — ${VIBE_ESCAPED}'
WHERE id = 'AGENT_ID';

-- Display identity aspect
INSERT INTO aspects (node_id, name, weight, extracted_with)
VALUES ('AGENT_ID', 'display', 9, 'seed');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Display name: ${DISPLAY_ESCAPED}', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Goes by: ${NICKNAMES_ESCAPED}', 9, 'seed', 'seed');

SEEDAPPEND

if [ -n "$VIBE" ]; then
cat >> "$AGENT_DIR/src/seed-graph.sql" << VIBE_SEED

-- Personality
INSERT INTO aspects (node_id, name, weight, extracted_with)
VALUES ('AGENT_ID', 'personality', 9, 'seed');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Core vibe: ${VIBE_ESCAPED}', 9, 'seed', 'seed');

VIBE_SEED
fi

if [ -n "$COMM_STYLE" ]; then
cat >> "$AGENT_DIR/src/seed-graph.sql" << VOICE_SEED

-- Communication style (extends the base voice aspect)
INSERT INTO aspects (node_id, name, weight, extracted_with)
VALUES ('AGENT_ID', 'communication', 9, 'seed');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), '${COMM_ESCAPED}', 9, 'seed', 'seed');

VOICE_SEED
fi

if [ -n "$QUIRKS_TEXT" ]; then
cat >> "$AGENT_DIR/src/seed-graph.sql" << QUIRK_SEED

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT MAX(id), '${QUIRKS_ESCAPED}', 8, 'seed', 'seed' FROM aspects WHERE node_id = 'AGENT_ID' AND name = 'communication';

QUIRK_SEED
fi

if [ -n "$INTERESTS_RAW" ]; then
cat >> "$AGENT_DIR/src/seed-graph.sql" << INT_SEED

-- Interests
INSERT INTO aspects (node_id, name, weight, extracted_with)
VALUES ('AGENT_ID', 'interests', 7, 'seed');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), '${INTERESTS_ESCAPED}', 7, 'seed', 'seed');

INT_SEED
fi

echo -e "${GREEN}  ✓ Personality seed written${NC}"

# ── Set ownership & permissions ────────────────────────────────────
# anima:anima (2000:2000) owns data and workspace (container-writable).
# ubuntu:anima owns src and config (host-managed, container-readable via group).
# setgid (2775) ensures new files inherit group anima.
chown -R 2000:2000 "$AGENT_DIR/data" "$AGENT_DIR/workspace" "$AGENT_DIR/static" 2>/dev/null || true
chown -R "$(id -u):2000" "$AGENT_DIR/src" 2>/dev/null || true
chown "$(id -u):2000" "$AGENT_DIR/anima.json" "$AGENT_DIR/.env" "$AGENT_DIR/brand.json" "$AGENT_DIR/docker-compose.yml" 2>/dev/null || true
find "$AGENT_DIR" -type d -exec chmod 2775 {} \; 2>/dev/null || true
find "$AGENT_DIR" -type f -exec chmod g+rw {} \; 2>/dev/null || true
echo -e "${GREEN}  ✓ Permissions set (group: anima)${NC}"

# ── Done ───────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║  ${GREEN}${DISPLAY_NAME}${NC}${BOLD} created!$(printf '%*s' $((32 - ${#DISPLAY_NAME})) '')║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${DIM}Location:  ${AGENT_DIR}${NC}"
echo -e "  ${DIM}Port:      ${PORT}${NC}"
echo -e "  ${DIM}DM policy: ${DM_POLICY}${NC}"
[ -n "$WEB_PORT" ] && echo -e "  ${DIM}Web port:  ${WEB_PORT}${NC}"
if [ "$INGRESS_MODE" = "traefik" ] && [ -n "$INGRESS_DOMAIN" ]; then
  PROTO="http"; [ "$INGRESS_HTTPS" = "true" ] && PROTO="https"
  echo -e "  ${GREEN}Public URL: ${PROTO}://${INGRESS_DOMAIN}${INGRESS_PATH}/${NC}"
fi
$HOST_ACCESS && echo -e "  ${YELLOW}Host read: ${HOST_PATHS}${NC}"
$PERSONALITY_EDITABLE && echo -e "  ${DIM}Personality: ${YELLOW}editable${NC}" || echo -e "  ${DIM}Personality: locked${NC}"
$SRC_EDITABLE && echo -e "  ${YELLOW}Source: editable (${BRAND_AGENT} can self-modify)${NC}" || echo -e "  ${DIM}Source: locked (secure)${NC}"
[ -n "$SLACK_BOT_TOKEN" ] && echo -e "  ${GREEN}Slack: enabled${NC}  ${DIM}(Socket Mode)${NC}"
if $VOICE_ENABLED; then
  TTS_LABEL="${VOICE_TTS_PROVIDER:-edge}"
  [ "$TTS_LABEL" = "elevenlabs" ] && TTS_LABEL="ElevenLabs"
  [ "$TTS_LABEL" = "openai" ] && TTS_LABEL="OpenAI"
  [ "$TTS_LABEL" = "edge" ] && TTS_LABEL="Edge TTS (free)"
  echo -e "  ${GREEN}Voice: enabled${NC}  ${DIM}(STT: Deepgram, TTS: ${TTS_LABEL})${NC}"
fi
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo ""
echo -e "  1. Fill in your API tokens:"
echo -e "     ${CYAN}${AGENT_DIR}/.env${NC}"
echo ""
echo -e "  2. Build the base image (if not done):"
echo -e "     ${CYAN}cd $SCRIPT_DIR && docker build -t anima:latest src/${NC}"
echo ""
echo -e "  3. Build and start ${DISPLAY_NAME}:"
echo -e "     ${CYAN}cd ${AGENT_DIR} && docker compose up --build -d${NC}"
echo ""
echo -e "  4. View logs:"
echo -e "     ${CYAN}docker logs -f ${AGENT_ID}${NC}"
echo ""
echo -e "  5. To update source code, edit files in:"
echo -e "     ${CYAN}${AGENT_DIR}/src/${NC}"
echo -e "     Then: ${CYAN}cd ${AGENT_DIR} && docker compose up --build -d${NC}"
echo ""
echo -e "  Health: ${CYAN}http://localhost:${PORT}/health${NC}"
echo ""

# Offer to build and start now
echo -e "${BOLD}Would you like to build and start ${DISPLAY_NAME} now?${NC}"
read -p "  Build & start? [Y/n]: " BUILD_NOW
if [[ ! "$BUILD_NOW" =~ ^[Nn]$ ]]; then
  echo ""
  ensure_buildx || echo -e "${YELLOW}⚠  Buildx may be too old — Compose build could fail.${NC}"
  echo -e "${CYAN}Building base image...${NC}"
  if docker build -t anima:latest "$SCRIPT_DIR/src/"; then
    echo -e "${CYAN}Starting ${DISPLAY_NAME}...${NC}"
    (cd "$AGENT_DIR" && docker compose up -d)
    echo ""
    echo -e "${GREEN}${DISPLAY_NAME} is starting!${NC} Check logs with: ${CYAN}docker logs -f ${AGENT_ID}${NC}"
  else
    echo -e "${YELLOW}Build failed. Fix errors above, then run manually:${NC}"
    echo -e "  ${CYAN}cd ${AGENT_DIR} && docker compose up --build -d${NC}"
  fi
  echo ""
fi
