#!/bin/sh
set -eu
. "$(dirname "$0")/backup-common.sh"
[ "$#" -ge 1 ] || fail 'Usage: sh scripts/restore.sh BACKUP_DIRECTORY --target-dir NEW_DIRECTORY --project NEW_PROJECT'
BACKUP_INPUT=$(CDPATH= cd -- "$1" && pwd)
shift
RESTORE_TARGET=
RESTORE_PROJECT=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir) [ "$#" -ge 2 ] || fail 'Missing --target-dir value'; RESTORE_TARGET=$2; shift 2;;
    --project) [ "$#" -ge 2 ] || fail 'Missing --project value'; RESTORE_PROJECT=$2; valid_project "$2"; shift 2;;
    *) fail "Unknown option: $1";;
  esac
done
[ -n "$RESTORE_TARGET" ] && [ -n "$RESTORE_PROJECT" ] || fail 'Both --target-dir and --project are required.'
case "$RESTORE_TARGET" in /*) ;; *) RESTORE_TARGET="$PWD/$RESTORE_TARGET";; esac
[ ! -L "$RESTORE_TARGET" ] || fail 'Restore target cannot be a symlink.'
if [ -e "$RESTORE_TARGET" ]; then
  [ -d "$RESTORE_TARGET" ] || fail 'Restore target must be an empty directory.'
  [ -z "$(ls -A "$RESTORE_TARGET")" ] || fail 'Restore target must be empty; existing installations cannot be overwritten.'
fi
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$RESTORE_PROJECT")" ] || fail 'Target project already has containers; choose a fresh project name.'
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$RESTORE_PROJECT")" ] || fail 'Target project already has volumes; choose a fresh project name.'
sh "$BACKUP_SCRIPT_DIR/verify-backup.sh" "$BACKUP_INPUT"
RESTORE_KEYS=$(helper -v "$BACKUP_INPUT:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py query manifest.json volume-keys)
for RESTORE_KEY in $RESTORE_KEYS; do
  if docker volume inspect "${RESTORE_PROJECT}_${RESTORE_KEY}" >/dev/null 2>&1; then
    fail "Target volume ${RESTORE_PROJECT}_${RESTORE_KEY} already exists; it will not be overwritten."
  fi
done
mkdir -p -- "$RESTORE_TARGET"
RESTORE_TARGET=$(CDPATH= cd -- "$RESTORE_TARGET" && pwd)
chmod 700 "$RESTORE_TARGET"
printf 'Restoring to new project %s; no services will be started automatically.\n' "$RESTORE_PROJECT"
helper -v "$BACKUP_INPUT:/input:ro" -v "$RESTORE_TARGET:/installation" \
  --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py restore-installation "$RESTORE_PROJECT"
for RESTORE_KEY in $RESTORE_KEYS; do
  RESTORE_VOLUME="${RESTORE_PROJECT}_${RESTORE_KEY}"
  docker volume create --label "com.docker.compose.project=$RESTORE_PROJECT" \
    --label "com.docker.compose.volume=$RESTORE_KEY" "$RESTORE_VOLUME" >/dev/null
  [ "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$RESTORE_VOLUME")" = "$RESTORE_PROJECT" ] || fail 'A conflicting volume appeared during restore; it will not be overwritten.'
  helper -v "$BACKUP_INPUT:/input:ro" -v "$RESTORE_VOLUME:/volume" \
    --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py restore-volume "$RESTORE_KEY"
done
RESTORE_HAS_IMAGES=$(helper -v "$BACKUP_INPUT:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py query manifest.json has-images)
if [ "$RESTORE_HAS_IMAGES" = true ]; then
  docker image load --input "$BACKUP_INPUT/images.tar.gz" >/dev/null
fi
helper -v "$RESTORE_TARGET:/installation" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py finish-restore
printf 'Restored files and volumes in %s\n' "$RESTORE_TARGET"
printf '%s\n' 'Before starting, set a different HTTP_PORT and HTTP_BIND in the restored .env if the original installation is still running.'
printf 'Start with: cd "%s" && docker compose -p %s -f compose.yaml -f restore-compose.yaml up -d --no-build\n' "$RESTORE_TARGET" "$RESTORE_PROJECT"
