#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm install

if [ ! -f .env.local ]; then
  cp .env.example .env.local
  token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  sed -i "s/^MAYFLY_ADMIN_TOKEN=.*/MAYFLY_ADMIN_TOKEN=${token}/" .env.local
  echo "Created .env.local for this codespace. Sign in with the admin token in that file."
fi

# Codespaces: leave PREVIEW_BASE_URL empty so Mayfly uses the forwarded :3000 URL,
# and prefer docker when the daemon is available via docker-outside-of-docker.
if [ -n "${CODESPACES:-}" ]; then
  if grep -q '^PREVIEW_BASE_URL=' .env.local; then
    sed -i 's|^PREVIEW_BASE_URL=.*|PREVIEW_BASE_URL=|' .env.local
  else
    echo "PREVIEW_BASE_URL=" >> .env.local
  fi
  if docker info >/dev/null 2>&1; then
    if grep -q '^PREVIEW_RUNTIME=' .env.local; then
      sed -i 's/^PREVIEW_RUNTIME=.*/PREVIEW_RUNTIME=docker/' .env.local
    else
      echo "PREVIEW_RUNTIME=docker" >> .env.local
    fi
  fi
fi
