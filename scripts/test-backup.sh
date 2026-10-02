#!/bin/sh
# Disposable restore drill; never uses the real installation's Compose project.
set -eu
. "$(dirname "$0")/backup-common.sh"
helper -v "$BACKUP_SCRIPT_DIR:/checks:ro" --entrypoint python \
  "$BACKUP_HELPER_IMAGE" /checks/test_backup_tool.py
DRILL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/paktrak-backup-check.XXXXXXXX")
DRILL_SOURCE="$DRILL_DIR/source"
DRILL_TARGET="$DRILL_DIR/restored"
DRILL_SOURCE_PROJECT="paktrak-backup-check-$(date -u +%Y%m%d%H%M%S)-$$"
DRILL_TARGET_PROJECT="$DRILL_SOURCE_PROJECT-restored"
mkdir -p "$DRILL_SOURCE/infra/generated"
source_compose() { docker compose -p "$DRILL_SOURCE_PROJECT" -f "$DRILL_SOURCE/compose.yaml" "$@"; }
target_compose() { docker compose -p "$DRILL_TARGET_PROJECT" -f "$DRILL_TARGET/compose.yaml" -f "$DRILL_TARGET/restore-compose.yaml" "$@"; }
cleanup() {
  DRILL_STATUS=$?
  trap - EXIT HUP INT TERM
  if [ -f "$DRILL_TARGET/restore-compose.yaml" ]; then target_compose down --volumes --timeout 5 >/dev/null 2>&1 || true; fi
  source_compose down --volumes --timeout 5 >/dev/null 2>&1 || true
  # Deliberately retain private logs/archives for diagnosis on failure.
  if [ "$DRILL_STATUS" -eq 0 ]; then rm -rf -- "$DRILL_DIR"; else printf 'Restore drill failed; private artifacts: %s\n' "$DRILL_DIR" >&2; fi
  exit "$DRILL_STATUS"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
cat > "$DRILL_SOURCE/.env" <<'ENV'
POSTGRES_PASSWORD=disposable-backup-drill-only
ENV
cat > "$DRILL_SOURCE/infra/generated/s3.json" <<'JSON'
{"disposable_backup_drill": true}
JSON
cat > "$DRILL_SOURCE/compose.yaml" <<'COMPOSE'
services:
  database:
    image: postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [database:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, pg_isready -U postgres]
      interval: 1s
      timeout: 3s
      retries: 30
  broker:
    image: alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
    command: [sh, -c, 'trap "exit 0" TERM; while :; do sleep 1; done']
    volumes: [broker:/data]
  storage:
    image: alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
    command: [sh, -c, 'trap "exit 0" TERM; while :; do sleep 1; done']
    volumes: [photos:/data]
  idle:
    image: alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
    command: [sh, -c, 'trap "exit 0" TERM; while :; do sleep 1; done']
volumes:
  database:
  broker:
  photos:
COMPOSE
source_compose up -d --wait >/dev/null
source_compose stop --timeout 5 idle >/dev/null
source_compose exec -T database psql -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE DATABASE scanner;
CREATE DATABASE identity_service;
\connect scanner
CREATE TABLE restore_witness (name text, quantity integer);
INSERT INTO restore_witness VALUES ('collection witness', 7);
\connect identity_service
CREATE TABLE restore_witness (account_name text);
INSERT INTO restore_witness VALUES ('identity witness');
SQL
source_compose exec -T storage sh -c 'mkdir /data/filer; printf "photo witness\n" > /data/filer/photo; chown 1234:1235 /data/filer/photo; chmod 640 /data/filer/photo; ln -s filer/photo /data/photo-link'
source_compose exec -T broker sh -c 'printf "broker witness\n" > /data/appendonly.aof'
sh "$BACKUP_SCRIPT_DIR/backup.sh" --directory "$DRILL_SOURCE" --project "$DRILL_SOURCE_PROJECT" "$DRILL_DIR/backup"
[ "$(source_compose ps --status running --services | wc -l | tr -d ' ')" = 3 ] || fail 'Backup did not resume exactly the previously running services.'
[ "$(docker inspect --format '{{.State.Running}}' "$(source_compose ps -aq idle)")" = false ] || fail 'Backup incorrectly started a previously stopped container.'
sh "$BACKUP_SCRIPT_DIR/restore.sh" "$DRILL_DIR/backup" --target-dir "$DRILL_TARGET" --project "$DRILL_TARGET_PROJECT"
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$DRILL_TARGET_PROJECT")" ] || fail 'Restore unexpectedly started services.'
target_compose up -d --no-build --wait >/dev/null
[ "$(target_compose exec -T database psql -U postgres -d scanner -Atc 'SELECT name,quantity FROM restore_witness')" = 'collection witness|7' ] || fail 'Application database did not restore.'
[ "$(target_compose exec -T database psql -U postgres -d identity_service -Atc 'SELECT account_name FROM restore_witness')" = 'identity witness' ] || fail 'Identity database did not restore.'
[ "$(target_compose exec -T storage cat /data/photo-link)" = 'photo witness' ] || fail 'Photo/filer file or symlink did not restore.'
[ "$(target_compose exec -T storage stat -c '%u:%g %a' /data/filer/photo)" = '1234:1235 640' ] || fail 'File ownership or permissions did not restore.'
[ "$(target_compose exec -T broker cat /data/appendonly.aof)" = 'broker witness' ] || fail 'Broker files did not restore.'
cmp "$DRILL_SOURCE/.env" "$DRILL_TARGET/.env"
cmp "$DRILL_SOURCE/infra/generated/s3.json" "$DRILL_TARGET/infra/generated/s3.json"
[ "$(stat -c %a "$DRILL_DIR/backup")" = 700 ] || fail 'Backup directory is not private.'
for DRILL_FILE in "$DRILL_DIR/backup"/* "$DRILL_TARGET/.env"; do
  [ "$(stat -c %a "$DRILL_FILE")" = 600 ] || fail 'Backup/configuration file is not private.'
done
if sh "$BACKUP_SCRIPT_DIR/restore.sh" "$DRILL_DIR/backup" --target-dir "$DRILL_TARGET" --project "$DRILL_TARGET_PROJECT" >"$DRILL_DIR/existing-target.log" 2>&1; then fail 'Restore accepted an existing installation.'; fi
mkdir "$DRILL_DIR/volume-refusal"
if sh "$BACKUP_SCRIPT_DIR/restore.sh" "$DRILL_DIR/backup" --target-dir "$DRILL_DIR/volume-refusal" --project "$DRILL_SOURCE_PROJECT" >"$DRILL_DIR/existing-volume.log" 2>&1; then fail 'Restore accepted an existing project.'; fi
cp -al "$DRILL_DIR/backup" "$DRILL_DIR/damaged"
rm "$DRILL_DIR/damaged/photos.tar.gz"
printf 'damaged archive\n' > "$DRILL_DIR/damaged/photos.tar.gz"
if sh "$BACKUP_SCRIPT_DIR/verify-backup.sh" "$DRILL_DIR/damaged" >"$DRILL_DIR/checksum.log" 2>&1; then fail 'Verification accepted a damaged archive.'; fi
printf '%s\n' 'Restore drill passed: application/identity databases, photos, broker, image startup, ownership, secrets, restart state and refusal/checksum safeguards.'
