#!/usr/bin/env sh
# Pull the latest code, rebuild and restart — keeping the running image as
# advertema:previous (and advertema:<old commit>) so it can be rolled back.
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
$COMPOSE build
$COMPOSE up -d
docker image prune -f >/dev/null

echo "Deployed $(git -C .. rev-parse --short HEAD). Logs: docker logs -f advertema"
