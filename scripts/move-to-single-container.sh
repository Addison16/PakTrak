#!/bin/sh
# Copies a Docker Compose installation's data into a folder for the
# single-container PakTrak image. The Compose containers are stopped, and
# their volumes are left untouched, so the old installation can be started
# again if needed.
set -eu
usage() {
  printf '%s\n' \
    'Usage: sh move-to-single-container.sh [--project NAME] [--env FILE] [--image IMAGE] DATA_DIR' \
    'Copy a Compose installation into DATA_DIR, the /data folder of the single PakTrak container.' \
    'The Compose project and its .env are found automatically when only one installation exists.'
}
fail() { printf '%s\n' "$*" >&2; exit 1; }
MOVE_PROJECT=
MOVE_ENV=
MOVE_IMAGE=ghcr.io/addison16/paktrak:latest
MOVE_TARGET=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || fail 'Missing --project value'; MOVE_PROJECT=$2; shift 2;;
    --env) [ "$#" -ge 2 ] || fail 'Missing --env value'; MOVE_ENV=$2; shift 2;;
    --image) [ "$#" -ge 2 ] || fail 'Missing --image value'; MOVE_IMAGE=$2; shift 2;;
    --help|-h) usage; exit 0;;
    --*) fail "Unknown option: $1";;
    *) [ -z "$MOVE_TARGET" ] || fail 'Specify only one data folder'; MOVE_TARGET=$1; shift;;
  esac
done
[ -n "$MOVE_TARGET" ] || { usage >&2; exit 1; }
SECRETS='POSTGRES_PASSWORD SCANNER_DB_PASSWORD KEYCLOAK_DB_PASSWORD SESSION_SECRET OIDC_CLIENT_SECRET PASSWORD_RESET_CLIENT_SECRET STORAGE_ACCESS_KEY STORAGE_SECRET_KEY KEYCLOAK_ADMIN_PASSWORD'

if [ -z "$MOVE_PROJECT" ]; then
  # Compose labels every container with its project; the API container identifies PakTrak.
  MOVE_PROJECT=$(docker ps -a --filter label=com.docker.compose.service=api \
    --format '{{.Image}} {{.Label "com.docker.compose.project"}}' \
    | awk '$1 ~ /paktrak-backend/ { print $2 }' | sort -u)
  case "$MOVE_PROJECT" in
    '') fail 'No Compose installation of PakTrak was found. Pass --project with its Compose project name.';;
    *[!a-z0-9_-]*) fail "More than one PakTrak installation was found; choose one with --project: $(printf '%s' "$MOVE_PROJECT" | tr '\n' ' ')";;
  esac
fi
case "$MOVE_PROJECT" in ''|*[!a-z0-9_-]*) fail 'Project names contain only lowercase letters, digits, underscores and hyphens.';; esac
for volume in database photos; do
  docker volume inspect "${MOVE_PROJECT}_$volume" >/dev/null 2>&1 || fail "Volume ${MOVE_PROJECT}_$volume was not found."
done

if [ -z "$MOVE_ENV" ]; then
  MOVE_DIR=$(docker ps -a --filter "label=com.docker.compose.project=$MOVE_PROJECT" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' | sed -n 1p)
  [ -n "$MOVE_DIR" ] || fail 'Could not find the installation folder. Pass --env with the path of its .env file.'
  MOVE_ENV=$MOVE_DIR/.env
fi
[ -r "$MOVE_ENV" ] || fail "Cannot read $MOVE_ENV. Pass --env with the path of the installation's .env file."
for name in $SECRETS; do
  grep -Eq "^$name=.+" "$MOVE_ENV" || fail "$MOVE_ENV has no $name; it does not look like a PakTrak .env file."
done
MOVE_URL=$(sed -n 's/^APP_URL=//p' "$MOVE_ENV" | tail -n 1)

if [ -e "$MOVE_TARGET" ] && [ -n "$(ls -A "$MOVE_TARGET")" ]; then
  fail "$MOVE_TARGET is not empty. Choose a new folder, or delete it if it holds nothing you need."
fi
mkdir -p "$MOVE_TARGET"
MOVE_TARGET=$(CDPATH= cd -- "$MOVE_TARGET" && pwd)

printf 'Downloading %s before stopping anything.\n' "$MOVE_IMAGE"
docker pull "$MOVE_IMAGE" >/dev/null 2>&1 || docker image inspect "$MOVE_IMAGE" >/dev/null 2>&1 || fail "Could not download $MOVE_IMAGE."

MOVE_RUNNING=$(docker ps -q --filter "label=com.docker.compose.project=$MOVE_PROJECT")
MOVE_DONE=false
restore() {
  if [ "$MOVE_DONE" = false ] && [ -n "$MOVE_RUNNING" ]; then
    printf '%s\n' 'The move did not finish; starting the Compose installation again.' >&2
    # shellcheck disable=SC2086
    docker start $MOVE_RUNNING >/dev/null || true
  fi
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
if [ -n "$MOVE_RUNNING" ]; then
  printf 'Stopping the Compose installation (%s).\n' "$MOVE_PROJECT"
  # shellcheck disable=SC2086
  docker stop -t 90 $MOVE_RUNNING >/dev/null
fi
printf 'Copying the database and photos into %s.\n' "$MOVE_TARGET"
docker run --rm --network none --entrypoint sh \
  -v "${MOVE_PROJECT}_database:/from/database:ro" \
  -v "${MOVE_PROJECT}_photos:/from/photos:ro" \
  -v "$MOVE_TARGET:/to" \
  "$MOVE_IMAGE" -ec 'cp -a /from/database /to/postgres; cp -a /from/photos /to/photos' \
  || fail "Copying failed. Delete $MOVE_TARGET before trying again."
(
  umask 077
  for name in $SECRETS; do grep -E "^$name=" "$MOVE_ENV" | tail -n 1; done > "$MOVE_TARGET/paktrak.env"
)
MOVE_DONE=true
printf '%s\n' '' "Done. Your data is in $MOVE_TARGET." \
  "Create the PakTrak container with this folder as its data path and APP_URL set to ${MOVE_URL:-the address you used before}." \
  'The Compose containers are stopped and their volumes are kept. Keep them stopped, and remove them once the new container works.'
