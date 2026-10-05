#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
START_BUILD=false
case "${1:-}" in
  --build) START_BUILD=true; shift;;
  --help|-h)
    printf '%s\n' 'Usage: sh scripts/start.sh [--build]' 'Pull released images and start PakTrak; --build builds this checkout locally instead.'
    exit 0;;
  '') ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 1;;
esac
[ "$#" -eq 0 ] || { printf '%s\n' 'Usage: sh scripts/start.sh [--build]' >&2; exit 1; }
if [ ! -f .env ]; then
  echo "Run sh scripts/setup.sh first." >&2
  exit 1
fi
sh scripts/setup.sh --upgrade
compose() {
  if [ "$START_BUILD" = true ]; then
    docker compose -f compose.yaml -f compose.build.yaml "$@"
  else
    docker compose -f compose.yaml "$@"
  fi
}
compose config --quiet
if [ "$START_BUILD" = false ]; then
  # Download every image before interrupting the installed application.
  compose pull
else
  if docker buildx version >/dev/null 2>&1; then
    compose build api web
  else
    # Some Linux Engine installs provide Compose without the Buildx plugin.
    START_BACKEND_IMAGE=$(compose config --images api | while IFS= read -r image; do
      case "$image" in ghcr.io/addison16/paktrak-backend:*) printf '%s\n' "$image"; break;; esac
    done)
    START_WEB_IMAGE=$(compose config --images web | while IFS= read -r image; do
      case "$image" in ghcr.io/addison16/paktrak-web:*) printf '%s\n' "$image"; break;; esac
    done)
    [ -n "$START_BACKEND_IMAGE" ] && [ -n "$START_WEB_IMAGE" ] || { printf '%s\n' 'Could not resolve application image names.' >&2; exit 1; }
    DOCKER_BUILDKIT=0 docker build --target runtime -t "$START_BACKEND_IMAGE" -f services/backend/Dockerfile .
    DOCKER_BUILDKIT=0 docker build -t "$START_WEB_IMAGE" -f apps/web/Dockerfile .
  fi
  compose pull database broker storage identity
fi
START_PAUSED=false
finish() {
  START_STATUS=$?
  if [ "$START_STATUS" -ne 0 ] && [ "$START_PAUSED" = true ]; then
    printf '%s\n' 'Startup failed. Review docker compose logs migrate api identity, fix the error, and retry sh scripts/start.sh.' >&2
  fi
}
trap finish EXIT
START_PAUSED=true
# Keep old application processes out of a schema upgrade; leave data volumes intact.
compose stop --timeout 90 web api worker transfer-worker dispatcher data-worker migrate
compose up -d --no-build --wait --wait-timeout 180 database broker storage identity
# Keycloak caches theme files supplied by Git, even when its image is unchanged.
compose restart identity
# Always re-run bootstrap, including when only the public hostname has changed.
# A failed migration exits here, before any application process is started.
compose up --no-build --no-deps --force-recreate --exit-code-from migrate migrate
compose up -d --no-build --no-deps --wait --wait-timeout 180 api worker transfer-worker dispatcher data-worker
compose up -d --no-build --no-deps --wait --wait-timeout 60 web
compose exec -T web nginx -t
compose exec -T web nginx -s reload
START_PAUSED=false
printf '%s\n' 'PakTrak is running. Use sh scripts/update.sh to install the next published release.'
