#!/usr/bin/env bash
# Move Mayfly's saved state to another server.
#
# On the OLD server:
#   bash ~/mayfly/deploy/aws/migrate.sh pack
#   # then scp -r data/migrate/mayfly-migrate-… and .env.local to the new server
#
# On the NEW server (Mayfly installed, stopped):
#   bash ~/mayfly/deploy/aws/migrate.sh apply ~/mayfly-migrate-…
#
# Secrets stay in .env.local and are never packed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

fail() { printf '\n%s\n' "$*" >&2; exit 1; }
compose() { sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml "$@"; }
tool() { compose run --rm --no-deps -T -v "$REPO_DIR/data:/app/data" mayfly node dist/restore.js "$@"; }

[ "$(id -u)" -ne 0 ] || fail "Run this as your normal user (ubuntu), not with sudo."
[ -f .env ] || fail "Mayfly isn't set up here yet. Run deploy/aws/setup.sh first."

case "${1:-}" in
  pack)
    tool pack
    echo
    echo "Next: copy that migrate folder AND .env.local to the new server, then on the new server:"
    echo "  bash deploy/aws/migrate.sh apply /path/to/mayfly-migrate-…"
    ;;
  apply)
    folder="${2:-}"
    [ -n "$folder" ] || fail "Say which packed folder: bash deploy/aws/migrate.sh apply /path/to/mayfly-migrate-…"
    [ -d "$folder" ] || fail "Folder not found: $folder"
    echo "This stops Mayfly, restores from the packed backup, and starts it again."
    read -rp "Type yes to continue: " answer
    [ "$answer" = "yes" ] || fail "Nothing changed."
    compose stop mayfly
    if ! tool apply "$folder" --yes; then
      compose start mayfly
      fail "The restore didn't happen, and Mayfly has been started again unchanged."
    fi
    compose start mayfly
    for _ in $(seq 1 60); do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/health || true)
      if [ "$code" = 200 ] || [ "$code" = 503 ]; then
        echo "Mayfly is running again with the restored state."
        exit 0
      fi
      sleep 2
    done
    fail "Mayfly didn't come back. See: sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml logs --tail=50 mayfly"
    ;;
  *) fail "Use: pack   or   apply <folder>" ;;
esac
