#!/usr/bin/env sh
# Pull the latest code, rebuild and restart — keeping the running image as
# advertema:previous (and advertema:<old commit>) so it can be rolled back.
#
# MIGRATIONS FIRST, OR NOTHING DEPLOYS. After the pull, the database is asked
# which migration versions it has applied (applied_migrations(), service role
# only), and the build is refused while supabase/migrations/ holds one it has
# not. Three deploys shipped code ahead of its schema before this. Nothing is
# applied here: the schema is changed by hand, on purpose, never as a side
# effect of pushing code. Rollback is not checked: an older image on a newer
# schema is what rollback is for.
#
#   ./deploy/update.sh            # update to the latest main
#   ./deploy/update.sh rollback   # go back to the image that ran before
set -eu

cd "$(dirname "$0")"
COMPOSE="docker compose --env-file .env.production"

if [ ! -f .env.production ]; then
  echo "deploy/.env.production is missing — copy .env.production.example and fill it in." >&2
  exit 1
fi

if [ "${1:-}" = "rollback" ]; then
  docker image inspect advertema:previous >/dev/null 2>&1 || { echo "No advertema:previous image to roll back to." >&2; exit 1; }
  docker tag advertema:previous advertema:latest
  $COMPOSE up -d --no-build --force-recreate
  echo "Rolled back to the previous image."
  exit 0
fi

# Remember what's running now
if docker image inspect advertema:latest >/dev/null 2>&1; then
  docker tag advertema:latest advertema:previous
  CURRENT=$(git -C .. rev-parse --short HEAD)
  docker tag advertema:latest "advertema:$CURRENT"
  echo "Current image kept as advertema:previous and advertema:$CURRENT"
fi

git -C .. pull --ff-only

# The two values the check needs, read from the env file without sourcing it
SUPABASE_URL=$(sed -n 's/^NEXT_PUBLIC_SUPABASE_URL=//p' .env.production | tr -d '"\r')
SERVICE_KEY=$(sed -n 's/^SUPABASE_SECRET_KEY=//p' .env.production | tr -d '"\r')
if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_KEY" ]; then
  echo "Cannot verify migrations: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY is missing from .env.production." >&2
  exit 1
fi
APPLIED=$(curl -sS -f -X POST "$SUPABASE_URL/rest/v1/rpc/applied_migrations" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H "Content-Type: application/json" -d '{}') || {
  echo "Cannot verify migrations: applied_migrations() did not answer. Is migration 20261105100000 applied?" >&2
  exit 1
}
MISSING=""
for file in ../supabase/migrations/*.sql; do
  version=$(basename "$file" | cut -d_ -f1)
  case "$APPLIED" in
    *"\"$version\""*) ;;
    *) MISSING="$MISSING
  $(basename "$file")" ;;
  esac
done
if [ -n "$MISSING" ]; then
  printf "REFUSING TO DEPLOY: the database has not applied:%b\nApply them first (npx supabase db push), then run this again.\n" "$MISSING" >&2
  exit 1
fi
echo "Migrations: every file in supabase/migrations is applied."

$COMPOSE build
$COMPOSE up -d
docker image prune -f >/dev/null

echo "Deployed $(git -C .. rev-parse --short HEAD). Logs: docker logs -f advertema"
