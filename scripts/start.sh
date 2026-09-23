#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo "Run sh scripts/setup.sh first." >&2
  exit 1
fi
sh scripts/setup.sh --upgrade
if docker buildx version >/dev/null 2>&1; then
  docker compose build api web
else
  # Some Linux Engine installs provide Compose without the Buildx plugin.
  DOCKER_BUILDKIT=0 docker build --target runtime -t mtg-scanner-backend:0.1.0 -f services/backend/Dockerfile .
  DOCKER_BUILDKIT=0 docker build -t mtg-scanner-web:0.1.0 -f apps/web/Dockerfile .
fi
docker compose up -d --no-build
# Compose can replace the API while keeping an unchanged web container. Reload
# nginx to resolve the new service addresses before serving the updated stack.
docker compose exec -T web nginx -t
docker compose exec -T web nginx -s reload
