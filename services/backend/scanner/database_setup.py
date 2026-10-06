"""Create PakTrak's PostgreSQL roles and databases when they are missing.

Runs as a one-shot Compose service before identity and migrations, so a plain
``compose.yaml`` + ``.env`` installation needs no init script on the host.
Existing roles, passwords and databases are never altered.
"""

import os
import time

import psycopg
from psycopg import sql

ROLES = (("scanner", "SCANNER_DB_PASSWORD"), ("identity_service", "KEYCLOAK_DB_PASSWORD"))
DATABASES = (
    ("scanner", "scanner"),
    ("scanner_test", "scanner"),
    ("identity_service", "identity_service"),
)


def required(name):
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"{name} is required; run setup or copy it from your existing .env.")
    return value


def connect():
    conninfo = psycopg.conninfo.make_conninfo(
        host=os.environ.get("POSTGRES_HOST", "database"),
        user="postgres",
        password=required("POSTGRES_PASSWORD"),
        dbname="postgres",
        connect_timeout=5,
    )
    for attempt in range(60):
        try:
            return psycopg.connect(conninfo, autocommit=True)
        except psycopg.OperationalError:
            if attempt == 59:
                raise
            time.sleep(2)


def plan(existing_roles, existing_databases, passwords):
    """Return the statements needed to create only what is missing."""
    statements = []
    for role, variable in ROLES:
        if role not in existing_roles:
            statements.append(
                sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(
                    sql.Identifier(role), sql.Literal(passwords[variable])
                )
            )
    for database, owner in DATABASES:
        if database not in existing_databases:
            statements.append(
                sql.SQL("CREATE DATABASE {} OWNER {}").format(
                    sql.Identifier(database), sql.Identifier(owner)
                )
            )
    return statements


def main():
    with connect() as connection:
        roles = {row[0] for row in connection.execute("SELECT rolname FROM pg_roles")}
        databases = {row[0] for row in connection.execute("SELECT datname FROM pg_database")}
        missing_roles = {role for role, _ in ROLES} - roles
        passwords = {
            variable: required(variable) for role, variable in ROLES if role in missing_roles
        }
        statements = plan(roles, databases, passwords)
        for statement in statements:
            connection.execute(statement)
    if statements:
        print(f"Created {len(statements)} missing database roles or databases.")
    else:
        print("Database roles and databases already exist; nothing changed.")


if __name__ == "__main__":
    main()
