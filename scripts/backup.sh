#!/bin/sh
set -eu
. "$(dirname "$0")/backup-common.sh"
BACKUP_PROJECT_DIR=$(CDPATH= cd -- "$BACKUP_SCRIPT_DIR/.." && pwd)
BACKUP_PROJECT=
BACKUP_DEST=
BACKUP_LEAVE_STOPPED=false
BACKUP_IMAGES=true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || fail 'Missing --project value'; BACKUP_PROJECT=$2; valid_project "$2"; shift 2;;
    --directory) [ "$#" -ge 2 ] || fail 'Missing --directory value'; BACKUP_PROJECT_DIR=$(CDPATH= cd -- "$2" && pwd); shift 2;;
    --leave-stopped) BACKUP_LEAVE_STOPPED=true; shift;;
    --without-images) BACKUP_IMAGES=false; shift;;
    --help|-h) printf '%s\n' 'Usage: sh scripts/backup.sh [--project NAME] [--directory PROJECT_DIR] [--leave-stopped] [--without-images] [DESTINATION]' 'Creates a coordinated cold backup; the installation is unavailable while its volumes are copied.'; exit 0;;
    --*) fail "Unknown option: $1";;
    *) [ -z "$BACKUP_DEST" ] || fail 'Specify only one destination'; BACKUP_DEST=$1; shift;;
  esac
done
[ -f "$BACKUP_PROJECT_DIR/compose.yaml" ] || fail 'Project directory needs compose.yaml'
[ -f "$BACKUP_PROJECT_DIR/.env" ] || fail 'Project directory needs its matching .env'
cd "$BACKUP_PROJECT_DIR"
compose() {
  if [ -n "$BACKUP_PROJECT" ]; then docker compose -p "$BACKUP_PROJECT" "$@"; else docker compose "$@"; fi
}
BACKUP_DEST=${BACKUP_DEST:-"$BACKUP_PROJECT_DIR/backups/paktrak-$(date -u +%Y%m%dT%H%M%SZ)"}
case "$BACKUP_DEST" in /*) ;; *) BACKUP_DEST="$BACKUP_PROJECT_DIR/$BACKUP_DEST";; esac
[ ! -e "$BACKUP_DEST" ] || fail 'Backup destination already exists; choose a new directory.'
mkdir -p -- "$(dirname -- "$BACKUP_DEST")"
BACKUP_PARENT=$(CDPATH= cd -- "$(dirname -- "$BACKUP_DEST")" && pwd)
BACKUP_DEST="$BACKUP_PARENT/$(basename -- "$BACKUP_DEST")"
BACKUP_STAGE=$(mktemp -d "$BACKUP_PARENT/.paktrak-backup.XXXXXXXX")
BACKUP_LOCK="$BACKUP_PROJECT_DIR/.paktrak-backup.lock"
if ! mkdir "$BACKUP_LOCK" 2>/dev/null; then
  rmdir "$BACKUP_STAGE"
  fail 'Another backup owns .paktrak-backup.lock; investigate it before removing a stale lock.'
fi
BACKUP_RUNNING=
BACKUP_STOPPED=false
BACKUP_COMPLETE=false
resume_previous() {
  if [ "$BACKUP_STOPPED" = true ] && [ "$BACKUP_LEAVE_STOPPED" = false ] && [ -n "$BACKUP_RUNNING" ]; then
    printf '%s\n' 'Resuming the containers that were running before the backup.'
    # Container IDs are sanitized hexadecimal IDs from Docker inspect.
    docker start $BACKUP_RUNNING >/dev/null || return 1
    BACKUP_STOPPED=false
  fi
}
cleanup() {
  BACKUP_STATUS=$?
  trap - EXIT HUP INT TERM
  if ! resume_previous; then
    printf '%s\n' 'Container resume failed. Start the installation manually; the backup files remain available.' >&2
    BACKUP_STATUS=1
  fi
  rmdir "$BACKUP_LOCK" 2>/dev/null || true
  if [ "$BACKUP_COMPLETE" = false ]; then
    printf 'Backup incomplete; private working files remain in %s\n' "$BACKUP_STAGE" >&2
  fi
  exit "$BACKUP_STATUS"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
compose config --format json | helper -i -v "$BACKUP_STAGE:/output" \
  --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py config >/dev/null
BACKUP_PROJECT=$(helper -v "$BACKUP_STAGE:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py query compose-plan.json project)
valid_project "$BACKUP_PROJECT"
BACKUP_IDS=$(docker ps -aq --filter "label=com.docker.compose.project=$BACKUP_PROJECT")
[ -n "$BACKUP_IDS" ] || fail 'No containers belong to this project; start it once before backing it up.'
docker inspect $BACKUP_IDS | helper -i -v "$BACKUP_STAGE:/output" \
  --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py containers >/dev/null
BACKUP_RUNNING=$(helper -v "$BACKUP_STAGE:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py query containers.json running)
BACKUP_VOLUME_ROWS=$(helper -v "$BACKUP_STAGE:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py query compose-plan.json volumes)
if [ "$BACKUP_IMAGES" = true ]; then
  BACKUP_IMAGE_IDS=$(helper -v "$BACKUP_STAGE:/input:ro" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py query containers.json images)
  printf '%s\n' 'Saving the exact installed container images before the maintenance pause.'
  docker image save --output "$BACKUP_STAGE/images.tar" $BACKUP_IMAGE_IDS
  helper -v "$BACKUP_STAGE:/output" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py compress-images
fi
printf 'Creating a cold backup of project %s.\n' "$BACKUP_PROJECT"
# Set this before stopping: interruptions and partial Docker failures must also resume prior containers.
BACKUP_STOPPED=true
if [ -n "$BACKUP_RUNNING" ]; then docker stop --time 90 $BACKUP_RUNNING >/dev/null; fi
for BACKUP_ID in $BACKUP_IDS; do
  [ "$(docker inspect --format '{{.State.Running}}' "$BACKUP_ID")" = false ] || fail 'A project container is still running; no volumes were copied.'
done
printf '%s\n' "$BACKUP_VOLUME_ROWS" | while IFS=' ' read -r BACKUP_KEY BACKUP_VOLUME; do
  [ -n "$BACKUP_KEY" ] || continue
  docker volume inspect "$BACKUP_VOLUME" >/dev/null
  [ -z "$(docker ps -q --filter "volume=$BACKUP_VOLUME")" ] || fail "Volume $BACKUP_VOLUME still has a running writer."
  printf 'Copying %s volume.\n' "$BACKUP_KEY"
  helper -v "$BACKUP_VOLUME:/volume:ro" -v "$BACKUP_STAGE:/output" \
    --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py archive-volume "$BACKUP_KEY"
done
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$BACKUP_PROJECT")" ] || fail 'A project container restarted during the backup; snapshot rejected.'
helper -v "$BACKUP_PROJECT_DIR:/installation:ro" -v "$BACKUP_STAGE:/output" \
  --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py archive-installation "$BACKUP_PROJECT_DIR" "$BACKUP_STAGE" "$BACKUP_DEST"
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$BACKUP_PROJECT")" ] || fail 'A project container restarted during the backup; snapshot rejected.'
resume_previous || fail 'Could not resume previous containers after the cold copy.'
helper -v "$BACKUP_STAGE:/output" --entrypoint python "$BACKUP_HELPER_IMAGE" /tool.py manifest
sh "$BACKUP_SCRIPT_DIR/verify-backup.sh" "$BACKUP_STAGE"
mv -- "$BACKUP_STAGE" "$BACKUP_DEST"
BACKUP_COMPLETE=true
printf 'Verified backup: %s\n' "$BACKUP_DEST"
