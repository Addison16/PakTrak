#!/bin/sh
# Development-instance test: interrupts this stack, clears its task broker,
# and recreates containers. Database/photo volumes are preserved.
set -eu
cd "$(dirname "$0")/.."
active=$(docker compose exec -T database psql -U postgres -d scanner -Atc \
  "SELECT count(*) FROM jobs LEFT JOIN scans ON scans.id=jobs.scan_id LEFT JOIN imports ON imports.id=jobs.import_id LEFT JOIN exports ON exports.id=jobs.export_id JOIN users ON users.id=COALESCE(scans.owner_id, imports.owner_id, exports.owner_id) WHERE jobs.state IN ('QUEUED','RUNNING') AND users.display_name NOT LIKE 'scanner-e2e-%'")
if [ "$active" != "0" ]; then
  echo "Recovery testing requires no active real scans or transfers. Use a development instance." >&2
  exit 1
fi
mkdir -p artifacts
rm -f artifacts/e2e-accepted.json artifacts/e2e-server-recovered
cleanup() {
  docker stop mtg-scanner-browser-test >/dev/null 2>&1 || true
  docker compose up -d --no-build api worker transfer-worker dispatcher web >/dev/null 2>&1
}
trap cleanup EXIT
docker compose stop worker transfer-worker
SCANNER_FAULT_TEST=1 sh scripts/test-browser.sh --grep 'mobile upload' --project chromium &
test_pid=$!
attempt=0
while [ ! -f artifacts/e2e-accepted.json ]; do
  if ! kill -0 "$test_pid" 2>/dev/null; then
    wait "$test_pid"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ]; then
    echo "Browser did not reach durable acceptance." >&2
    exit 1
  fi
  sleep 1
done
job_id=$(docker run --rm -v "$PWD/artifacts:/artifacts:ro" \
  python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e \
  python -c 'import json,uuid; print(uuid.UUID(json.load(open("/artifacts/e2e-accepted.json"))["job_id"]))')
# Wait for a recorded publication, then deliberately lose that broker message.
attempt=0
while :; do
  published=$(docker compose exec -T -e E2E_JOB_ID="$job_id" api python -c \
    'import os,uuid; from scanner.db import session_factory; from scanner.models import Outbox; db=session_factory()(); row=db.get(Outbox,uuid.UUID(os.environ["E2E_JOB_ID"])); print(bool(row and row.last_sent_at))')
  [ "$published" = "True" ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -le 20 ] || exit 1
  sleep 1
done
docker compose stop dispatcher
docker compose exec -T broker valkey-cli FLUSHDB
docker compose up -d --no-build --force-recreate database storage broker identity migrate api dispatcher web
docker compose up -d --no-build worker transfer-worker
attempt=0
while :; do
  state=$(docker compose exec -T -e E2E_JOB_ID="$job_id" api python -c \
    'import os,uuid; from scanner.db import session_factory; from scanner.models import Job; db=session_factory()(); print(db.get(Job,uuid.UUID(os.environ["E2E_JOB_ID"])).state)' 2>/dev/null || true)
  # State polling observes SQL only; the browser remains closed during recovery.
  [ "$state" = "SUCCEEDED" ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -le 30 ] || exit 1
  sleep 1
done
printf ready > artifacts/e2e-server-recovered
wait "$test_pid"
