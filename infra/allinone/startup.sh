#!/bin/sh
# Runs once per container start, in the order compose.yaml and
# scripts/start.sh use: database roles, sign-in service, migrations, then the
# app and finally the web server. A failure stops the container.
set -eu
log() { printf 'paktrak: %s\n' "$*"; }
ctl() { supervisorctl -c /etc/paktrak/supervisord.conf "$@"; }
fail() {
  log "$1"
  log 'Startup stopped. Check the messages above, fix the cause and start the container again.'
  ctl shutdown >/dev/null 2>&1 || true
  exit 1
}
wait_for() {
  name=$1 attempts=$2
  shift 2
  until "$@" >/dev/null 2>&1; do
    failed=$(ctl status | awk '$2 == "FATAL" { print $1 }' | tr '\n' ' ')
    [ -z "$failed" ] || fail "These services could not start: $failed"
    attempts=$((attempts - 1))
    [ "$attempts" -gt 0 ] || fail "$name did not become ready."
    sleep 2
  done
}
url_ready() { python -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=5)" "$1"; }
as_app() { gosu paktrak "$@"; }

wait_for 'The database' 300 pg_isready -h 127.0.0.1 -U postgres -q
log 'Preparing database roles.'
as_app python -m scanner.database_setup || fail 'Database setup failed.'
ctl start identity >/dev/null || fail 'The sign-in service could not start.'
log 'Waiting for the sign-in service.'
wait_for 'The sign-in service' 180 url_ready http://127.0.0.1:9000/identity/health/ready
log 'Running migrations and sign-in setup.'
SCANNER_IDENTITY_ADMIN_PASSWORD=$KEYCLOAK_ADMIN_PASSWORD as_app python -m scanner.bootstrap || fail 'Migrations or sign-in setup failed.'
ctl start api worker transfer-worker dispatcher data-worker >/dev/null || fail 'The app services could not start.'
wait_for 'The API' 90 url_ready http://127.0.0.1:8000/api/health/ready
ctl start web >/dev/null || fail 'The web server could not start.'
log "PakTrak is running. Open $APP_URL"
