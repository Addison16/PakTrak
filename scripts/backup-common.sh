#!/bin/sh
# Shared helpers. Invoked by the backup scripts, not directly.
set -eu
umask 077
BACKUP_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKUP_HELPER_IMAGE=python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e
BACKUP_UID=$(id -u)
BACKUP_GID=$(id -g)

fail() { printf '%s\n' "$*" >&2; exit 1; }
helper() {
  docker run --rm --network none --security-opt no-new-privileges:true \
    -e BACKUP_UID="$BACKUP_UID" -e BACKUP_GID="$BACKUP_GID" \
    -v "$BACKUP_SCRIPT_DIR/backup_tool.py:/tool.py:ro" "$@"
}
valid_project() {
  case "$1" in ''|*[!a-z0-9_-]*|[_-]*) fail 'Project names must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores or hyphens.';; esac
}
