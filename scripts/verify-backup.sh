#!/bin/sh
set -eu
. "$(dirname "$0")/backup-common.sh"
[ "$#" -eq 1 ] || fail 'Usage: sh scripts/verify-backup.sh BACKUP_DIRECTORY'
BACKUP_INPUT=$(CDPATH= cd -- "$1" && pwd)
helper -v "$BACKUP_INPUT:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py verify
