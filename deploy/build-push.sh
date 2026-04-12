#!/usr/bin/env bash
set -euo pipefail

# Build and push Anima Docker images to a container registry.
# Usage: ./build-push.sh [registry]
#
# Examples:
#   ./build-push.sh                          # builds locally only
#   ./build-push.sh ghcr.io/Klace         # pushes to GitHub Container Registry
#   ./build-push.sh docker.io/your-user      # pushes to Docker Hub

REGISTRY="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo 'latest')"
VERSION="$(cd "$REPO_ROOT" && grep '"version"' src/package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || echo '0.3.0')"

echo "=== Anima Image Build ==="
echo "  Version: ${VERSION}"
echo "  Git SHA: ${GIT_SHA}"
echo "  Registry: ${REGISTRY:-local only}"
echo ""

# Build agent image
echo "[1/2] Building anima:${VERSION}..."
docker build -t "anima:latest" -t "anima:${VERSION}" -t "anima:${GIT_SHA}" "${REPO_ROOT}/src"

# Build manager image
echo "[2/2] Building anima-manager:${VERSION}..."
docker build -t "anima-manager:latest" -t "anima-manager:${VERSION}" -t "anima-manager:${GIT_SHA}" "${REPO_ROOT}/manager"

echo ""
echo "Local images built:"
echo "  anima:latest / anima:${VERSION} / anima:${GIT_SHA}"
echo "  anima-manager:latest / anima-manager:${VERSION} / anima-manager:${GIT_SHA}"

if [ -n "${REGISTRY}" ]; then
  echo ""
  echo "Pushing to ${REGISTRY}..."

  for img in anima anima-manager; do
    for tag in latest "${VERSION}" "${GIT_SHA}"; do
      docker tag "${img}:${tag}" "${REGISTRY}/${img}:${tag}"
      docker push "${REGISTRY}/${img}:${tag}"
      echo "  Pushed ${REGISTRY}/${img}:${tag}"
    done
  done

  echo ""
  echo "All images pushed to ${REGISTRY}"
fi

echo "=== Done ==="
