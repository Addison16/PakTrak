#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# The whole script runs from one function: an update replaces this file, and
# the shell must not read the new copy halfway through.
main() {
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
# Installs unpacked from a source archive (for example on Unraid, which has no
# Git) download each release's archive instead of checking out its tag.
UPDATE_FROM_GIT=false
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  UPDATE_FROM_GIT=true
  # Refuse to discard source edits; ignored private configuration is preserved.
  git diff --quiet HEAD -- || { printf '%s\n' 'Commit or save your tracked source edits before updating.' >&2; exit 1; }
else
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'This install has no Git checkout, so updating needs %s.\n' "$tool" >&2; exit 1; }
  done
fi
UPDATE_LOCK=.paktrak-update.lock
mkdir "$UPDATE_LOCK" 2>/dev/null || { printf '%s\n' 'Another update owns .paktrak-update.lock; check for an active update before removing a stale lock.' >&2; exit 1; }
UPDATE_STAGE=
trap 'rmdir "$UPDATE_LOCK" 2>/dev/null || true; [ -z "$UPDATE_STAGE" ] || rm -rf "$UPDATE_STAGE"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
UPDATE_TAG=$(docker run --rm --user "$(id -u):$(id -g)" \
  --security-opt no-new-privileges:true --cap-drop ALL \
  -v "$PWD/scripts/release.py:/release.py:ro" \
  python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e \
  python /release.py resolve "$UPDATE_VERSION")
printf 'Installing PakTrak %s.\n' "$UPDATE_TAG"
if [ "$UPDATE_FROM_GIT" = true ]; then
  git fetch --no-tags origin "refs/tags/$UPDATE_TAG"
  # Git refuses untracked-file collisions. The checkout supplies matching themes,
  # setup helpers and Compose configuration without touching .env or named volumes.
  git checkout --detach FETCH_HEAD
else
  UPDATE_STAGE=$(mktemp -d .paktrak-update.XXXXXX)
  curl -fsSL -o "$UPDATE_STAGE/source.tar.gz" "https://github.com/Addison16/PakTrak/archive/refs/tags/$UPDATE_TAG.tar.gz"
  mkdir "$UPDATE_STAGE/source"
  tar -xzf "$UPDATE_STAGE/source.tar.gz" -C "$UPDATE_STAGE/source" --strip-components=1
  [ -f "$UPDATE_STAGE/source/compose.yaml" ] && [ -f "$UPDATE_STAGE/source/scripts/start.sh" ] || { printf '%s\n' 'The downloaded release archive is incomplete; nothing was changed.' >&2; exit 1; }
  # Release archives never contain .env, so private settings stay in place.
  cp -R "$UPDATE_STAGE/source/." .
fi
sh scripts/setup.sh --upgrade --image-version "${UPDATE_TAG#v}"
PAKTRAK_VERSION=${UPDATE_TAG#v}
export PAKTRAK_VERSION
sh scripts/start.sh
}
main "$@"; exit
