#!/usr/bin/env bash
# Sets up Mayfly on a fresh Ubuntu 24.04 server (AWS EC2 or similar) for a short test run.
#
#   git clone https://github.com/Meetamadhu/mayfly.git ~/mayfly
#   bash ~/mayfly/deploy/aws/setup.sh
#
# Run it as the normal login user (ubuntu), not root. Safe to run again: it keeps an existing .env.local,
# updates the address if the server's IP changed, and rebuilds. Secrets are written to .env.local and never printed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSetup stopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as your normal user (ubuntu), not with sudo."
[ -f docker-compose.yml ] || fail "can't find docker-compose.yml in $REPO_DIR."

say "Installing Docker (skipped if it's already there)"
if ! command -v docker >/dev/null 2>&1 || ! sudo docker compose version >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo systemctl enable --now docker >/dev/null

mem_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 4000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  say "Adding 2 GB of swap (this server has only ${mem_mb} MB of memory)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

say "Finding this server's public address"
if [ -n "${MAYFLY_HOST:-}" ]; then
  host="$MAYFLY_HOST"
else
  ip=$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]') || true
  [[ "${ip:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "couldn't read the public IP. Run again with MAYFLY_HOST=<your address>."
  # sslip.io turns 1-2-3-4.sslip.io into 1.2.3.4, so the server gets a real name and a free HTTPS certificate.
  host="${ip//./-}.sslip.io"
fi
echo "Mayfly will be at https://$host"

# Docker Compose reads .env for ${...} values in the compose files. Rewritten every run in case the IP changed.
cat > .env <<EOF
# Written by deploy/aws/setup.sh. Docker Compose reads it; edit .env.local for Mayfly's own settings.
MAYFLY_HOST=$host
PREVIEW_BASE_URL=https://$host
EOF

if [ -f .env.local ]; then
  say "Keeping your existing .env.local"
else
  say "Creating .env.local with a new admin token and webhook secret"
  (
    umask 077
    cat > .env.local <<EOF
# Mayfly settings for this server. Only you can read this file. Never commit it.
MAYFLY_ADMIN_TOKEN=$(openssl rand -hex 32)
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Paste your fine-grained GitHub token after the = sign, then run setup.sh again.
GITHUB_TOKEN=

# Repositories whose pull requests are built. Others are refused, and pull requests from forks are never built.
PREVIEW_REPOS=meetamadhu/mayfly-sample-app,meetamadhu/mayfly-sample-api

# Previews and builds. Admins can change lifetime and sleep later on the Lifetime rules page.
PREVIEW_TTL_HOURS=168
PREVIEW_MAX_LIFETIME_HOURS=168
PREVIEW_SLEEP_SECONDS=60
MAX_CONCURRENT_ENVIRONMENTS=6
PREVIEW_MAX_BUILDS=1
PREVIEW_BUILD_MEMORY=2g
PREVIEW_BUILD_CPUS=1
PREVIEW_MEMORY=512m
PREVIEW_CPUS=0.5

# Lets admins try a pull request from the Admin page without going to GitHub.
ALLOW_SIMULATOR=true
EOF
  )
fi
chmod 600 .env.local

say "Cleaning up unused Docker images every day"
sudo tee /etc/cron.daily/mayfly-docker-prune >/dev/null <<'EOF'
#!/bin/sh
# Old Mayfly builds and leftover build cache. Preview images are tagged, so they aren't touched.
docker image prune -f >/dev/null 2>&1
docker builder prune -f --filter until=72h >/dev/null 2>&1
exit 0
EOF
sudo chmod 755 /etc/cron.daily/mayfly-docker-prune

say "Building and starting Mayfly (the first build takes a few minutes)"
sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml up -d --build --remove-orphans

say "Waiting for Mayfly to answer"
ok=""
for _ in $(seq 1 90); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/webhooks/github >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || fail "Mayfly didn't start. See: sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml logs --tail=50 mayfly"

say "Waiting for the HTTPS certificate"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$host/api/webhooks/github" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ -z "$ok" ]; then
  echo "Mayfly is running, but https://$host doesn't answer yet."
  echo "Check that the security group allows HTTP (80) and HTTPS (443) from anywhere, then run this script again."
  echo "Caddy's log: sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml logs --tail=30 caddy"
  exit 1
fi

token_state="set"
grep -Eq '^(GITHUB_TOKEN|MAYFLY_GITHUB_TOKEN)=.+' .env.local || token_state="missing"

cat <<EOF

Mayfly is up at https://$host

Next:
  1. Open https://$host/board in your browser.
  2. Show the admin token and webhook secret (only on this server, don't paste them anywhere else):
       grep -E '^(MAYFLY_ADMIN_TOKEN|GITHUB_WEBHOOK_SECRET)=' $REPO_DIR/.env.local
  3. In each sample repository on GitHub, set the webhook to:
       URL:          https://$host/api/webhooks/github
       Content type: application/json
       Secret:       the GITHUB_WEBHOOK_SECRET value
       Events:       Pull requests
EOF
if [ "$token_state" = "missing" ]; then
  cat <<EOF
  4. GitHub token: missing, so Mayfly can't post PR comments yet. Add it with
       nano $REPO_DIR/.env.local
     then run this script again.
EOF
fi
