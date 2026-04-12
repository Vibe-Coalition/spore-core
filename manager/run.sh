#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/.env" 2>/dev/null; set +a
export ANIMAS_DIR="${ANIMAS_DIR:-$SCRIPT_DIR/../animas}"
export SHARED_DIR="${SHARED_DIR:-$SCRIPT_DIR/../shared}"
cd "$SCRIPT_DIR"
exec "/usr/bin/node" server.js
