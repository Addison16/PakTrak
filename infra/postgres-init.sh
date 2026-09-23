#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname postgres \
  --set=scanner_password="$SCANNER_DB_PASSWORD" \
  --set=identity_password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE USER scanner WITH PASSWORD :'scanner_password';
CREATE DATABASE scanner OWNER scanner;
CREATE DATABASE scanner_test OWNER scanner;
CREATE USER identity_service WITH PASSWORD :'identity_password';
CREATE DATABASE identity_service OWNER identity_service;
SQL
