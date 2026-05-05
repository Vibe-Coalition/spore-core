#!/usr/bin/env bash
# Build and (optionally) push Spore Core Docker images.
#
# Day-to-day, the official `ghcr.io/<owner>/<repo>:<tag>` image is built
# automatically by .github/workflows/docker-publish.yml on push/tag.
# This script is for local builds and ad-hoc pushes from a dev box.
#
# Usage:
#   ./build-push.sh                            # local build only
#   ./build-push.sh ghcr.io/<owner>/<repo>     # build + push to a registry
#   ./build-push.sh docker.io/<user>/spore-core
set -euo pipefail

REGISTRY="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo 'latest')"
VERSION="$(cd "$REPO_ROOT" && grep '"version"' src/package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || echo '0.3.0')"

echo "=== Spore Core Image Build ==="
echo "  Version: ${VERSION}"
echo "  Git SHA: ${GIT_SHA}"
echo "  Registry: ${REGISTRY:-local only}"
echo ""

# Build context = repo root so `COPY src/...` and `COPY plugins/` both
# resolve. The Dockerfile lives at src/Dockerfile.
echo "[build] spore-core:${VERSION}"
docker build \
  -f "${REPO_ROOT}/src/Dockerfile" \
  -t "spore-core:latest" \
  -t "spore-core:${VERSION}" \
  -t "spore-core:${GIT_SHA}" \
  "${REPO_ROOT}"

echo ""
echo "Local images built:"
echo "  spore-core:latest"
echo "  spore-core:${VERSION}"
echo "  spore-core:${GIT_SHA}"

if [ -n "${REGISTRY}" ]; then
  echo ""
  echo "Pushing to ${REGISTRY}..."

  for tag in latest "${VERSION}" "${GIT_SHA}"; do
    docker tag "spore-core:${tag}" "${REGISTRY}:${tag}"
    docker push "${REGISTRY}:${tag}"
    echo "  Pushed ${REGISTRY}:${tag}"
  done

  echo ""
  echo "All images pushed to ${REGISTRY}"
fi

echo "=== Done ==="
