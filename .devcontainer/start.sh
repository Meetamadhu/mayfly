#!/bin/bash
# Start Mayfly in the background whenever this Codespace starts.
# Must return quickly: a blocking postStartCommand leaves the UI on "Setting up your codespace".
set -euo pipefail
cd "$(dirname "$0")/.."

if curl -sf "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "Mayfly is already listening on :3000"
  exit 0
fi

npm run build
nohup npm start -- -H 0.0.0.0 >/tmp/mayfly.log 2>&1 &
echo "Mayfly starting on :3000 (log: /tmp/mayfly.log)"
# Give the server a moment so the forwarded port is claimed.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "Mayfly is ready on :3000"
    exit 0
  fi
  sleep 1
done
echo "Mayfly did not become ready in time; check /tmp/mayfly.log"
exit 0
