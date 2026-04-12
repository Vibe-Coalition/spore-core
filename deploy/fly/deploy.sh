#!/usr/bin/env bash
set -euo pipefail

# Deploy Anima to Fly.io
# Usage: ./deploy.sh [agent-id]

AGENT_ID="${1:-anima}"
APP_NAME="anima-${AGENT_ID}"
REGION="${FLY_REGION:-iad}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Deploying Anima agent '${AGENT_ID}' to Fly.io ==="

if ! command -v fly &>/dev/null; then
  echo "Error: flyctl not installed. See https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
fi

# Create app if it doesn't exist
if ! fly apps list --json | grep -q "\"${APP_NAME}\""; then
  echo "Creating app ${APP_NAME}..."
  fly apps create "${APP_NAME}" --org personal
fi

# Create volumes if they don't exist
for vol in "${AGENT_ID}_data" "${AGENT_ID}_workspace"; do
  if ! fly volumes list -a "${APP_NAME}" --json 2>/dev/null | grep -q "\"${vol}\""; then
    echo "Creating volume ${vol}..."
    fly volumes create "${vol}" --size 1 --region "${REGION}" -a "${APP_NAME}" -y
  fi
done

# Check secrets
echo "Checking secrets..."
if ! fly secrets list -a "${APP_NAME}" 2>/dev/null | grep -q "ANTHROPIC_API_KEY"; then
  echo ""
  echo "WARNING: ANTHROPIC_API_KEY not set. Run:"
  echo "  fly secrets set ANTHROPIC_API_KEY=sk-ant-... -a ${APP_NAME}"
  echo ""
fi

# Deploy
echo "Deploying from ${REPO_ROOT}/src..."
cd "${REPO_ROOT}/src"
fly deploy \
  --app "${APP_NAME}" \
  --region "${REGION}" \
  --env "AGENT_ID=${AGENT_ID}" \
  --env "ANIMA_DISPLAY_NAME=${AGENT_ID}" \
  --env "HEALTH_BIND_ADDR=0.0.0.0"

echo "=== Deployed! Check: fly status -a ${APP_NAME} ==="
