#!/usr/bin/env bash
# Mayfly's backups on this server.
#
#   bash ~/mayfly/deploy/aws/backup.sh              list backups, newest first
#   bash ~/mayfly/deploy/aws/backup.sh now          take one now
#   bash ~/mayfly/deploy/aws/backup.sh restore <name>
#
# Mayfly takes one a day by itself and keeps the newest 7 (BACKUP_KEEP in .env.local). They're in
# ~/mayfly/data/backups, on this server's disk. Restore stops Mayfly, puts the backup back, keeps a copy of
# what was there before, and starts Mayfly again.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

fail() { printf '\n%s\n' "$*" >&2; exit 1; }
compose() { sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml "$@"; }
# A one-off container from the Mayfly image, with the same settings and data folder, without the web server.
tool() { compose run --rm --no-deps -T mayfly node dist/restore.js "$@"; }

[ "$(id -u)" -ne 0 ] || fail "Run this as your normal user (ubuntu), not with sudo."
[ -f .env ] || fail "Mayfly isn't set up here yet. Run deploy/aws/setup.sh first."

case "${1:-list}" in
  list) tool list ;;
  now) tool now ;;
  restore)
    name="${2:-}"
    [ -n "$name" ] || fail "Say which backup: bash deploy/aws/backup.sh restore <name>. See the names with: bash deploy/aws/backup.sh"
    tool show "$name"
    echo
    echo "This stops Mayfly for about a minute, replaces its saved state with this backup, and starts it again."
    echo "Previews restart from the backup, the same as after a normal restart."
    read -rp "Type yes to restore: " answer
    [ "$answer" = "yes" ] || fail "Nothing changed."
    compose stop mayfly
    if ! tool restore "$name" --yes; then
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
  *) fail "Unknown command $1. Use: list, now, or restore <name>." ;;
esac
