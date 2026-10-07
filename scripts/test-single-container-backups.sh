#!/bin/sh
# Checks automatic backups in the single-container image: a backup made in the
# running container, the keep-count, a restore chosen in the app, and a move to
# a fresh data folder through the restore folder.
#   sh scripts/test-single-container-backups.sh IMAGE
set -eu
IMAGE=${1:?Usage: sh scripts/test-single-container-backups.sh IMAGE}
FIRST=paktrak-backup-first
SECOND=paktrak-backup-second
FIRST_DATA=$(mktemp -d)
SECOND_DATA=$(mktemp -d)
cleanup() {
  docker rm -f "$FIRST" "$SECOND" >/dev/null 2>&1 || true
  docker run --rm -v "$FIRST_DATA:/a" -v "$SECOND_DATA:/b" --entrypoint sh "$IMAGE" -c 'rm -rf /a/* /b/*' >/dev/null 2>&1 || true
  rmdir "$FIRST_DATA" "$SECOND_DATA" 2>/dev/null || true
}
trap cleanup EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; docker logs --tail 80 "$CURRENT" >&2 || true; exit 1; }
started() {
  CURRENT=$1
  for i in $(seq 1 150); do
    [ "$(docker logs "$1" 2>&1 | grep -c 'PakTrak is running')" -ge "$2" ] && return 0
    docker logs "$1" 2>&1 | grep -q 'Startup stopped' && fail "$1 did not start"
    sleep 3
  done
  fail "$1 did not start in time"
}
psql_in() { docker exec "$1" psql -h /var/run/postgresql -U postgres -w -d scanner -Atc "$2"; }
backups_in() { docker exec "$1" sh -c "ls /data/backups | grep '^paktrak-backup-' || true"; }
wait_for_file() {
  for i in $(seq 1 60); do
    backups_in "$1" | grep -q -- "$2" && return 0
    sleep 2
  done
  fail "no backup matching $2 in $1"
}

docker run -d --name "$FIRST" -e APP_URL=http://localhost:8095 -v "$FIRST_DATA:/data" "$IMAGE" >/dev/null
started "$FIRST" 1
# The first start makes an automatic backup on its own.
wait_for_file "$FIRST" 'Z\.tar$'
psql_in "$FIRST" "UPDATE account_policy SET tcgplayer_affiliate = 'saved-in-backup'" >/dev/null
docker exec "$FIRST" sh -c 'printf "{\"enabled\": true, \"keep\": 2}\n" > /data/backups/settings.json && chown paktrak:paktrak /data/backups/settings.json && touch /data/backups/backup-requested'
wait_for_file "$FIRST" 'Z-manual\.tar$'
docker exec "$FIRST" sh -c 'touch /data/backups/backup-requested'
for i in $(seq 1 60); do [ "$(backups_in "$FIRST" | grep -c manual)" -ge 2 ] && break; sleep 2; done
[ "$(backups_in "$FIRST" | wc -l)" -eq 2 ] || fail "keep-count of 2 not applied: $(backups_in "$FIRST")"
[ -z "$(backups_in "$FIRST" | grep -v manual)" ] || fail 'the oldest backup was not the one removed'
SAVED=$(backups_in "$FIRST" | sort | head -n 1)
docker exec "$FIRST" sh -c 'stat -c "%u %a" /data/backups/'"$SAVED" | grep -qx '10001 600' || fail 'backup files must be private to the app'

# Restore chosen in the app, then a container restart.
psql_in "$FIRST" "UPDATE account_policy SET tcgplayer_affiliate = 'changed-later'" >/dev/null
docker exec "$FIRST" sh -c "printf '{\"name\": \"$SAVED\"}\n' > /data/backups/restore-requested.json"
docker restart -t 120 "$FIRST" >/dev/null
started "$FIRST" 2
[ "$(psql_in "$FIRST" 'SELECT tcgplayer_affiliate FROM account_policy')" = saved-in-backup ] || fail 'in-place restore did not bring the data back'
backups_in "$FIRST" | grep -q 'before-restore' || fail 'the data before the restore was not saved'
docker exec "$FIRST" test -f /data/backups/last-restore.json || fail 'restore was not recorded'
docker exec "$FIRST" test ! -e /data/paktrak.env.before-restore || fail 'old settings left behind'

# Move: a fresh data folder at a new address, restoring from the restore folder.
docker run --rm -v "$FIRST_DATA:/a" -v "$SECOND_DATA:/b" --entrypoint sh "$IMAGE" -c "mkdir /b/restore && cp /a/backups/$SAVED /b/restore/moved.tar"
docker run -d --name "$SECOND" -e APP_URL=http://localhost:8096 -v "$SECOND_DATA:/data" "$IMAGE" >/dev/null
started "$SECOND" 1
[ "$(psql_in "$SECOND" 'SELECT tcgplayer_affiliate FROM account_policy')" = saved-in-backup ] || fail 'moved data is missing'
docker exec "$SECOND" sh -c 'ls /data/restore' | grep -q . && fail 'the restore folder was not emptied'
backups_in "$SECOND" | grep -q 'imported' || fail 'the moved backup is not listed'
docker exec "$SECOND" python -c "import urllib.request, json; d = json.load(urllib.request.urlopen('http://127.0.0.1:8180/identity/realms/scanner/.well-known/openid-configuration')); assert d['issuer'].startswith('http://localhost:8096/'), d['issuer']"
[ "$(docker exec "$SECOND" sh -c 'grep ^OIDC_CLIENT_SECRET= /data/paktrak.env')" = "$(docker exec "$FIRST" sh -c 'grep ^OIDC_CLIENT_SECRET= /data/paktrak.env')" ] || fail 'private settings did not move with the backup'
printf '%s\n' 'Backups, keep-count, restore and move all passed.'
