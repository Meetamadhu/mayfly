#!/bin/bash
# Start Mayfly whenever this Codespace starts (or restarts).
set -euo pipefail
cd "$(dirname "$0")/.."

if curl -sf "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "Mayfly is already listening on :3000"
  exit 0
fi

npm run build
# Bind all interfaces so the forwarded Codespace URL can reach the app.
exec npm start -- -H 0.0.0.0
