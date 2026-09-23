#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if docker buildx version >/dev/null 2>&1; then
  docker compose --profile test build tests
else
  DOCKER_BUILDKIT=0 docker build --target test -t mtg-scanner-tests:0.1.0 -f services/backend/Dockerfile .
fi
docker compose --profile test run --rm tests
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/source" -w /source \
  mtg-scanner-tests:0.1.0 ruff check --no-cache services tests scripts migrations
docker compose exec -T api alembic check
