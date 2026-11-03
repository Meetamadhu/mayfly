#!/bin/bash
set -euo pipefail
npm install
if [ -f .env.local ]; then
  exit 0
fi
cp .env.example .env.local
token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
sed -i "s/^MAYFLY_ADMIN_TOKEN=.*/MAYFLY_ADMIN_TOKEN=${token}/" .env.local
echo "Created .env.local for this codespace. Sign in with the admin token in that file."
