#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# domain-helper.sh — DNS validation + setup guide for domain config
#
# Source this file, then call:
#   check_domain_dns <domain>
#
# Returns 0 if domain resolves to this server's public IP.
# Shows a setup guide and returns 1 if it doesn't.
# ═══════════════════════════════════════════════════════════════════

_BOLD='\033[1m'
_DIM='\033[2m'
_GREEN='\033[0;32m'
_YELLOW='\033[0;33m'
_RED='\033[0;31m'
_CYAN='\033[0;36m'
_NC='\033[0m'

detect_public_ip() {
  local ip=""
  for svc in "https://ifconfig.me" "https://api.ipify.org" "https://icanhazip.com"; do
    ip=$(curl -s --max-time 4 "$svc" 2>/dev/null | tr -d '[:space:]')
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "$ip"
      return 0
    fi
  done
  return 1
}

resolve_domain() {
  local domain="$1"
  if command -v dig &>/dev/null; then
    dig +short "$domain" A 2>/dev/null | head -1
  elif command -v nslookup &>/dev/null; then
    nslookup "$domain" 2>/dev/null | awk '/^Address: / { print $2 }' | tail -1
  elif command -v getent &>/dev/null; then
    getent ahostsv4 "$domain" 2>/dev/null | awk '{ print $1; exit }'
  else
    return 1
  fi
}

check_domain_dns() {
  local domain="$1"
  [ -z "$domain" ] && return 1

  echo "" >&2
  echo -e "  ${_DIM}Checking DNS for ${_CYAN}${domain}${_NC}${_DIM}...${_NC}" >&2

  local public_ip
  public_ip=$(detect_public_ip 2>/dev/null)
  if [ -z "$public_ip" ]; then
    echo -e "  ${_YELLOW}Could not detect this server's public IP.${_NC}" >&2
    echo -e "  ${_DIM}Make sure your domain's DNS A record points to this server.${_NC}" >&2
    return 1
  fi

  echo -e "  ${_DIM}This server's public IP: ${_CYAN}${public_ip}${_NC}" >&2

  local resolved_ip
  resolved_ip=$(resolve_domain "$domain")

  if [ "$resolved_ip" = "$public_ip" ]; then
    echo -e "  ${_GREEN}✓ ${domain} resolves to ${public_ip} — DNS is configured correctly${_NC}" >&2
    return 0
  fi

  if [ -n "$resolved_ip" ]; then
    echo -e "  ${_YELLOW}⚠  ${domain} resolves to ${resolved_ip}, not ${public_ip}${_NC}" >&2
  else
    echo -e "  ${_YELLOW}⚠  ${domain} does not resolve to any IP address yet${_NC}" >&2
  fi

  echo "" >&2
  read -p "  Show DNS setup guide? [Y/n]: " SHOW_GUIDE >&2
  if [[ "$SHOW_GUIDE" =~ ^[Nn]$ ]]; then
    return 1
  fi

  echo "" >&2
  echo -e "  ${_BOLD}── DNS Setup Guide ───────────────────────────────────────${_NC}" >&2
  echo "" >&2
  echo -e "  You need an ${_BOLD}A record${_NC} pointing ${_CYAN}${domain}${_NC} to ${_CYAN}${public_ip}${_NC}" >&2
  echo "" >&2
  echo -e "  ${_BOLD}What to set:${_NC}" >&2
  echo -e "    Type:  ${_CYAN}A${_NC}" >&2
  echo -e "    Host:  ${_CYAN}@${_NC}  ${_DIM}(or subdomain if using one, e.g. \"anima\")${_NC}" >&2
  echo -e "    Value: ${_CYAN}${public_ip}${_NC}" >&2
  echo -e "    TTL:   ${_CYAN}300${_NC}  ${_DIM}(or \"Automatic\")${_NC}" >&2
  echo "" >&2
  echo -e "  ${_BOLD}Where to set it (by provider):${_NC}" >&2
  echo "" >&2
  echo -e "  ${_CYAN}Namecheap${_NC}" >&2
  echo -e "  ${_DIM}  Dashboard → Domain List → Manage → Advanced DNS → Add A Record${_NC}" >&2
  echo -e "  ${_DIM}  https://www.namecheap.com/support/knowledgebase/article.aspx/319/${_NC}" >&2
  echo "" >&2
  echo -e "  ${_CYAN}Cloudflare${_NC}" >&2
  echo -e "  ${_DIM}  Dashboard → select domain → DNS → Records → Add record (type A)${_NC}" >&2
  echo -e "  ${_DIM}  Disable the orange proxy cloud if using Traefik for TLS.${_NC}" >&2
  echo -e "  ${_DIM}  https://developers.cloudflare.com/dns/manage-dns-records/${_NC}" >&2
  echo "" >&2
  echo -e "  ${_CYAN}GoDaddy${_NC}" >&2
  echo -e "  ${_DIM}  My Products → DNS → Add Record → Type A${_NC}" >&2
  echo -e "  ${_DIM}  https://www.godaddy.com/help/add-an-a-record-19238${_NC}" >&2
  echo "" >&2
  echo -e "  ${_CYAN}Google Domains / Squarespace Domains${_NC}" >&2
  echo -e "  ${_DIM}  DNS → Custom records → Create new → Type A${_NC}" >&2
  echo "" >&2
  echo -e "  ${_CYAN}Other providers${_NC}" >&2
  echo -e "  ${_DIM}  Look for \"DNS Management\" or \"Zone Editor\" in your registrar's dashboard.${_NC}" >&2
  echo -e "  ${_DIM}  Add an A record with host @ and value ${public_ip}${_NC}" >&2
  echo "" >&2
  echo -e "  ${_DIM}DNS changes can take 1–30 minutes to propagate (sometimes up to 48h).${_NC}" >&2
  echo -e "  ${_DIM}Test: ${_CYAN}dig +short ${domain}${_NC}  ${_DIM}or${_NC}  ${_CYAN}nslookup ${domain}${_NC}" >&2
  echo "" >&2

  read -p "  Continue with setup anyway? [Y/n]: " CONTINUE_ANYWAY >&2
  if [[ "$CONTINUE_ANYWAY" =~ ^[Nn]$ ]]; then
    return 2
  fi

  return 1
}
