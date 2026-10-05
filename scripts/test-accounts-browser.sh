#!/bin/sh
# Tests real OIDC registration against a disposable application database. The
# dedicated OIDC client/callback cannot create a live application administrator.
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p artifacts
created=0
client_config="$PWD/artifacts/accounts-client.json"
client_admin() {
  docker run --rm --network host --user "$(id -u):$(id -g)" \
    -v "$PWD:$PWD" -w "$PWD" mtg-scanner-tests:0.1.0 \
    python scripts/account-test-client.py "$@"
}
cleanup() {
  docker rm -f mtg-scanner-accounts-e2e-web >/dev/null 2>&1 || true
  docker rm -f mtg-scanner-accounts-e2e-api >/dev/null 2>&1 || true
  if [ "$created" = 1 ]; then
    docker compose exec -T database psql -U postgres -d postgres -c 'DROP DATABASE scanner_accounts_e2e WITH (FORCE)' >/dev/null
  fi
  if [ -f "$client_config" ]; then
    client_admin remove "$client_config"
  fi
}
trap cleanup EXIT INT TERM
export SCANNER_ACCOUNTS_E2E_URL=http://localhost:18097
for browser in chromium webkit; do
  client_admin create "$client_config"
  docker compose exec -T database psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE scanner_accounts_e2e OWNER scanner' >/dev/null
  created=1
  docker compose --profile test run -d --rm --no-deps --name mtg-scanner-accounts-e2e-api \
    -v "$PWD/services/backend:/app/services/backend:ro" -v "$PWD/migrations:/app/migrations:ro" \
    -p 127.0.0.1:18096:8000 -v "$PWD/scripts/account-test-server.py:/tmp/account-test-server.py:ro" \
    --user "$(id -u):$(id -g)" -v "$client_config:/tmp/client.json:ro" \
    tests python /tmp/account-test-server.py /tmp/client.json >/dev/null
  attempt=0
  until curl --fail --silent http://127.0.0.1:18096/api/health/ready >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      echo "Isolated account API did not become ready." >&2
      exit 1
    fi
    sleep 1
  done
  docker run -d --rm --name mtg-scanner-accounts-e2e-web --network mtg-scanner_private \
    -p 127.0.0.1:18097:8080 -v "$PWD/scripts/accounts-test-nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$PWD/apps/web/dist:/usr/share/nginx/html:ro" \
    --entrypoint nginx "$(docker compose images -q web)" -g 'daemon off;' >/dev/null
  sh scripts/test-browser.sh --grep 'first-run administrator' --project "$browser"
  cleanup
  created=0
done
