#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# platform.sh — Cross-platform detection helpers
#
# Source this file, then use:
#   $ANIMA_OS        — "linux", "macos", or "wsl"
#   $ANIMA_ARCH      — "x86_64" or "arm64"
#   $ANIMA_IS_LOCAL  — "true" if no public IP / likely a desktop
#   $ANIMA_HAS_SYSTEMD  — "true" if systemd is available
#   $ANIMA_HAS_APT      — "true" if apt-get is available
#   $ANIMA_HAS_BREW     — "true" if Homebrew is available
#
#   install_docker    — Install Docker for the detected platform
#   install_node      — Install Node.js for the detected platform
#   ensure_group      — Create anima group (or skip on macOS)
#   anima_host_url    — Returns base URL reachable from host browser
# ═══════════════════════════════════════════════════════════════════

_detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin) echo "macos" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    *) echo "linux" ;;
  esac
}

_detect_arch() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) echo "x86_64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "$machine" ;;
  esac
}

_detect_local() {
  # Heuristic: if we can't reach a public IP service or we're on macOS/WSL,
  # we're probably on a local machine, not a VPS.
  if [ "$ANIMA_OS" = "macos" ] || [ "$ANIMA_OS" = "wsl" ]; then
    echo "true"
    return
  fi
  # Check for desktop environment indicators
  if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ] || [ -n "$XDG_CURRENT_DESKTOP" ]; then
    echo "true"
    return
  fi
  echo "false"
}

ANIMA_OS="$(_detect_os)"
ANIMA_ARCH="$(_detect_arch)"
ANIMA_IS_LOCAL="$(_detect_local)"
ANIMA_HAS_SYSTEMD="false"
ANIMA_HAS_APT="false"
ANIMA_HAS_BREW="false"

command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1 && ANIMA_HAS_SYSTEMD="true"
command -v apt-get &>/dev/null && ANIMA_HAS_APT="true"
command -v brew &>/dev/null && ANIMA_HAS_BREW="true"

# On WSL2, localhost forwarding to Windows is unreliable.
# Resolve the WSL IP so scripts can print a URL the host browser can reach.
if [ "$ANIMA_OS" = "wsl" ]; then
  ANIMA_WSL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

# anima_host_url <port> — returns http://<host>:<port>
# On WSL bare mode: uses the WSL IP (localhost forwarding is unreliable).
# On WSL Docker mode: uses localhost (Docker Desktop handles forwarding).
anima_host_url() {
  local port="$1"
  if [ -n "$ANIMA_WSL_IP" ] && [ "${BARE_MODE:-false}" = "true" ]; then
    echo "http://${ANIMA_WSL_IP}:${port}"
  else
    echo "http://localhost:${port}"
  fi
}

install_docker() {
  case "$ANIMA_OS" in
    macos)
      echo -e "${YELLOW}  Docker Desktop is required on macOS.${NC}"
      echo ""
      if [ "$ANIMA_ARCH" = "arm64" ]; then
        echo -e "  Download: ${CYAN}https://desktop.docker.com/mac/main/arm64/Docker.dmg${NC}"
      else
        echo -e "  Download: ${CYAN}https://desktop.docker.com/mac/main/amd64/Docker.dmg${NC}"
      fi
      echo ""
      if [ "$ANIMA_HAS_BREW" = "true" ]; then
        read -p "  Install via Homebrew? [Y/n]: " BREW_DOCKER
        if [[ ! "$BREW_DOCKER" =~ ^[Nn]$ ]]; then
          brew install --cask docker
          echo -e "${GREEN}  ✓ Docker Desktop installed via Homebrew${NC}"
          echo -e "${YELLOW}  ⚠  Open Docker Desktop from Applications to start the daemon.${NC}"
          return 0
        fi
      fi
      echo -e "  Install Docker Desktop, start it, then re-run this script."
      return 1
      ;;
    wsl)
      echo -e "${YELLOW}  Docker Desktop for Windows with WSL2 backend is recommended.${NC}"
      echo ""
      echo -e "  Download: ${CYAN}https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe${NC}"
      echo -e "  ${DIM}Enable WSL2 backend in Docker Desktop → Settings → Resources → WSL Integration${NC}"
      echo ""
      # Try the Linux install as fallback
      if [ "$ANIMA_HAS_APT" = "true" ]; then
        read -p "  Or install Docker Engine in WSL? [y/N]: " WSL_DOCKER
        if [[ "$WSL_DOCKER" =~ ^[Yy]$ ]]; then
          curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
          sudo sh /tmp/get-docker.sh
          rm -f /tmp/get-docker.sh
          sudo usermod -aG docker "$USER" 2>/dev/null || true
          echo -e "${GREEN}  ✓ Docker installed in WSL${NC}"
          return 0
        fi
      fi
      return 1
      ;;
    linux)
      if [ "$ANIMA_HAS_APT" = "true" ]; then
        read -p "  Install Docker Engine now? [Y/n]: " INSTALL_DOCKER
        if [[ ! "$INSTALL_DOCKER" =~ ^[Nn]$ ]]; then
          echo -e "${CYAN}  Installing Docker via get.docker.com...${NC}"
          curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
          sudo sh /tmp/get-docker.sh
          rm -f /tmp/get-docker.sh
          if ! id -nG "$USER" | grep -qw docker; then
            sudo usermod -aG docker "$USER"
            echo -e "${GREEN}  ✓ Added '${USER}' to the docker group${NC}"
            echo -e "${YELLOW}  ⚠  You may need to log out and back in for group changes to take effect.${NC}"
          fi
          return 0
        fi
      else
        echo -e "  Install Docker: ${CYAN}https://docs.docker.com/get-docker/${NC}"
      fi
      return 1
      ;;
  esac
}

ensure_buildx() {
  local min_version="0.17.0"
  local current=""
  if docker buildx version &>/dev/null; then
    current=$(docker buildx version 2>/dev/null | grep -oP 'v?\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  fi

  if [ -z "$current" ]; then
    echo -e "  ${YELLOW}Docker Buildx not found. Docker Compose build requires buildx ${min_version}+.${NC}"
  else
    # Compare versions: split into major.minor.patch
    local cur_major cur_minor cur_patch min_major min_minor min_patch
    IFS='.' read -r cur_major cur_minor cur_patch <<< "$current"
    IFS='.' read -r min_major min_minor min_patch <<< "$min_version"
    local cur_num=$((cur_major * 10000 + cur_minor * 100 + cur_patch))
    local min_num=$((min_major * 10000 + min_minor * 100 + min_patch))
    if [ "$cur_num" -ge "$min_num" ]; then
      echo -e "  ${GREEN}✓ Docker Buildx v${current}${NC}"
      return 0
    fi
    echo -e "  ${YELLOW}Docker Buildx v${current} is too old — Compose build needs v${min_version}+.${NC}"
  fi

  echo -e "  ${CYAN}Upgrading Docker Buildx...${NC}"

  if [ "$ANIMA_OS" = "macos" ] || [ "$ANIMA_OS" = "wsl" ]; then
    echo -e "  ${DIM}Buildx is bundled with Docker Desktop. Update Docker Desktop to get a newer version.${NC}"
    echo -e "  ${DIM}Attempting direct binary upgrade as fallback...${NC}"
  fi

  local arch_label=""
  case "$ANIMA_ARCH" in
    x86_64)  arch_label="linux-amd64" ;;
    arm64)   arch_label="linux-arm64" ;;
    *)       arch_label="linux-amd64" ;;
  esac
  if [ "$ANIMA_OS" = "macos" ]; then
    case "$ANIMA_ARCH" in
      arm64) arch_label="darwin-arm64" ;;
      *)     arch_label="darwin-amd64" ;;
    esac
  fi

  # Resolve the latest release version from GitHub redirect
  local latest_tag
  latest_tag=$(curl -sI "https://github.com/docker/buildx/releases/latest" 2>/dev/null \
    | grep -i '^location:' | grep -oP 'v\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  latest_tag="${latest_tag:-0.21.0}"

  local buildx_url="https://github.com/docker/buildx/releases/download/v${latest_tag}/buildx-v${latest_tag}.${arch_label}"
  local tmp_file="/tmp/docker-buildx-$$"
  echo -e "  ${DIM}Downloading buildx v${latest_tag} from GitHub...${NC}"

  if curl -fSL --progress-bar "$buildx_url" -o "$tmp_file"; then
    chmod +x "$tmp_file"
    local installed=false
    for plugin_dir in "$HOME/.docker/cli-plugins" "/usr/local/lib/docker/cli-plugins" "/usr/lib/docker/cli-plugins"; do
      mkdir -p "$plugin_dir" 2>/dev/null || sudo mkdir -p "$plugin_dir" 2>/dev/null || continue
      if mv "$tmp_file" "$plugin_dir/docker-buildx" 2>/dev/null || \
         sudo mv "$tmp_file" "$plugin_dir/docker-buildx" 2>/dev/null; then
        installed=true
        break
      fi
    done
    rm -f "$tmp_file" 2>/dev/null

    if [ "$installed" = "true" ]; then
      local new_ver
      new_ver=$(docker buildx version 2>/dev/null | grep -oP 'v?\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)
      echo -e "  ${GREEN}✓ Docker Buildx upgraded to v${new_ver:-${min_version}}${NC}"
      return 0
    fi
  fi
  rm -f "$tmp_file" 2>/dev/null

  echo -e "  ${RED}Could not auto-upgrade Buildx.${NC}"
  echo -e "  ${DIM}Update Docker Desktop or install manually:${NC}"
  echo -e "  ${DIM}  https://github.com/docker/buildx#manual-download${NC}"
  return 1
}

install_node() {
  local auto="${QUICK_MODE:-false}"
  case "$ANIMA_OS" in
    macos)
      if [ "$ANIMA_HAS_BREW" = "true" ]; then
        if [ "$auto" = "true" ]; then
          echo -e "  ${CYAN}Installing Node.js 22 via Homebrew...${NC}"
          brew install node@22 || brew install node
          brew link --overwrite node@22 2>/dev/null || true
          echo -e "${GREEN}  ✓ Node.js installed via Homebrew${NC}"
          return 0
        fi
        read -p "  Install Node.js 22 via Homebrew? [Y/n]: " BREW_NODE
        if [[ ! "$BREW_NODE" =~ ^[Nn]$ ]]; then
          brew install node@22 || brew install node
          brew link --overwrite node@22 2>/dev/null || true
          echo -e "${GREEN}  ✓ Node.js installed via Homebrew${NC}"
          return 0
        fi
      else
        echo -e "  Install Node.js 22+: ${CYAN}https://nodejs.org/${NC}"
        echo -e "  ${DIM}Or install Homebrew first: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${NC}"
      fi
      return 1
      ;;
    *)
      if [ "$ANIMA_HAS_APT" = "true" ]; then
        if [ "$auto" != "true" ]; then
          read -p "  Install Node.js 22.x LTS now? [Y/n]: " INSTALL_NODE
          if [[ "$INSTALL_NODE" =~ ^[Nn]$ ]]; then return 1; fi
        fi
        echo -e "  ${CYAN}Installing Node.js 22.x via NodeSource...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
        echo -e "${GREEN}  ✓ Node.js installed${NC}"
        return 0
      else
        echo -e "  Install Node.js 22+: ${CYAN}https://nodejs.org/${NC}"
      fi
      return 1
      ;;
  esac
}

ensure_group() {
  local gid="${1:-2000}"
  case "$ANIMA_OS" in
    macos)
      # macOS: create group via dscl if it doesn't exist
      if ! dscl . -read /Groups/anima &>/dev/null 2>&1; then
        sudo dscl . -create /Groups/anima
        sudo dscl . -create /Groups/anima PrimaryGroupID "$gid"
        echo -e "${GREEN}  ✓ Created group 'anima' (GID $gid)${NC}"
      fi
      # Add user to group
      if ! id -Gn "$USER" 2>/dev/null | grep -qw anima; then
        sudo dscl . -append /Groups/anima GroupMembership "$USER"
        echo -e "${GREEN}  ✓ Added '$USER' to group 'anima'${NC}"
      fi
      ;;
    *)
      if ! getent group "$gid" &>/dev/null; then
        sudo groupadd -g "$gid" anima 2>/dev/null || true
        echo -e "${CYAN}  Created group 'anima' (GID $gid)${NC}"
      fi
      if ! id -nG "$USER" | grep -qw "$(getent group $gid | cut -d: -f1)"; then
        local grpname
        grpname=$(getent group "$gid" | cut -d: -f1)
        sudo usermod -aG "$grpname" "$USER"
        echo -e "${YELLOW}  ⚠  You may need to log out and back in for group changes to take effect.${NC}"
      fi
      ;;
  esac
}

install_watcher_service() {
  local script_dir="$1"
  local bare_mode="${2:-false}"
  local watcher_script="$script_dir/anima-watcher.js"

  if [ ! -f "$watcher_script" ]; then
    echo -e "  ${RED}  anima-watcher.js not found${NC}"
    return 1
  fi

  if [ "$ANIMA_HAS_SYSTEMD" = "true" ]; then
    local node_path
    node_path=$(command -v node)

    local dep_unit=""
    local bare_env=""
    if [ "$bare_mode" = "true" ]; then
      dep_unit="After=network.target"
      bare_env="Environment=ANIMA_BARE_MODE=true"
    else
      dep_unit="After=docker.service
Requires=docker.service"
    fi

    echo -e "  ${CYAN}Installing anima-watcher.service...${NC}"
    sudo tee /etc/systemd/system/anima-watcher.service > /dev/null << SVCEOF
[Unit]
Description=Anima Watcher — auto-start, restart, and stop agents
${dep_unit}

[Service]
Type=simple
User=$USER
WorkingDirectory=$script_dir
ExecStart=$node_path $watcher_script
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=ANIMAS_DIR=$script_dir/animas
Environment=POLL_MS=3000
${bare_env}

[Install]
WantedBy=multi-user.target
SVCEOF
    sudo systemctl daemon-reload
    sudo systemctl enable anima-watcher
    sudo systemctl start anima-watcher
    echo -e "  ${GREEN}✓ anima-watcher.service installed and started${NC}"

  elif [ "$ANIMA_OS" = "macos" ]; then
    local node_path
    node_path=$(command -v node)
    local plist="$HOME/Library/LaunchAgents/com.anima.watcher.plist"
    mkdir -p "$HOME/Library/LaunchAgents"

    local bare_env_plist=""
    if [ "$bare_mode" = "true" ]; then
      bare_env_plist="    <key>ANIMA_BARE_MODE</key><string>true</string>"
    fi

    cat > "$plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.anima.watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>$watcher_script</string>
  </array>
  <key>WorkingDirectory</key><string>$script_dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANIMAS_DIR</key><string>$script_dir/animas</string>
    <key>POLL_MS</key><string>3000</string>
${bare_env_plist}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/anima-watcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/anima-watcher.log</string>
</dict>
</plist>
PLISTEOF
    launchctl load "$plist" 2>/dev/null || true
    echo -e "  ${GREEN}✓ Watcher installed as macOS Launch Agent${NC}"
    echo -e "  ${DIM}  Logs: /tmp/anima-watcher.log${NC}"

  else
    echo -e "  ${YELLOW}⚠  No systemd or launchd available.${NC}"
    echo -e "  ${DIM}  Run manually: node $watcher_script${NC}"
    return 1
  fi
}
