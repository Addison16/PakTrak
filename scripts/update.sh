#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
UPDATE_VERSION=
case "${1:-}" in
  --version)
    [ "$#" -eq 2 ] || { printf '%s\n' 'Usage: sh scripts/update.sh [--version vX.Y.Z]' >&2; exit 1; }
    UPDATE_VERSION=$2;;
  --help|-h)
    printf '%s\n' 'Usage: sh scripts/update.sh [--version vX.Y.Z]' 'Install the latest published stable release, or one specified published release.'
    exit 0;;
  '') ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 1;;
esac
[ -f .env ] || { printf '%s\n' 'Run sh scripts/setup.sh first.' >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null
# Refuse to discard source edits; ignored private configuration is preserved.
git diff --quiet HEAD -- || { printf '%s\n' 'Commit or save your tracked source edits before updating.' >&2; exit 1; }
UPDATE_LOCK=.paktrak-update.lock
mkdir "$UPDATE_LOCK" 2>/dev/null || { printf '%s\n' 'Another update owns .paktrak-update.lock; check for an active update before removing a stale lock.' >&2; exit 1; }
trap 'rmdir "$UPDATE_LOCK" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
UPDATE_TAG=$(docker run --rm --user "$(id -u):$(id -g)" \
  --security-opt no-new-privileges:true --cap-drop ALL \
  -v "$PWD/scripts/release.py:/release.py:ro" \
  python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e \
  python /release.py resolve "$UPDATE_VERSION")
printf 'Installing PakTrak %s.\n' "$UPDATE_TAG"
git fetch --no-tags origin "refs/tags/$UPDATE_TAG"
# Git refuses untracked-file collisions. The checkout supplies matching themes,
# setup helpers and Compose configuration without touching .env or named volumes.
git checkout --detach FETCH_HEAD
sh scripts/setup.sh --upgrade --image-version "${UPDATE_TAG#v}"
PAKTRAK_VERSION=${UPDATE_TAG#v}
export PAKTRAK_VERSION
sh scripts/start.sh
