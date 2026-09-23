#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm \
  -v "$PWD:/workspace" -w /workspace/apps/web \
  node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 npm ci
docker run --rm --name mtg-scanner-browser-test --network host --ipc host --user "$(id -u):$(id -g)" \
  -e SCANNER_FAULT_TEST="${SCANNER_FAULT_TEST:-0}" \
  -e SCANNER_ACCOUNTS_E2E_URL="${SCANNER_ACCOUNTS_E2E_URL:-}" \
  -v "$PWD:/workspace" -w /workspace/apps/web \
  mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  npm run test:e2e -- "$@"
