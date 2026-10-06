"""The database-setup service creates only missing roles and databases."""

import pytest

from scanner import database_setup

PASSWORDS = {"SCANNER_DB_PASSWORD": "scanner-fixture", "KEYCLOAK_DB_PASSWORD": "identity-fixture"}


def rendered(statements):
    return [repr(statement) for statement in statements]


def test_fresh_installation_creates_every_role_and_database():
    statements = rendered(database_setup.plan({"postgres"}, {"postgres"}, PASSWORDS))
    assert len(statements) == 5
    for role, password in (
        ("scanner", "scanner-fixture"),
        ("identity_service", "identity-fixture"),
    ):
        assert any(
            "CREATE ROLE " in item
            and f"Identifier('{role}')" in item
            and f"Literal('{password}')" in item
            for item in statements
        )
    for database in ("scanner", "scanner_test", "identity_service"):
        assert any(
            "CREATE DATABASE " in item and f"Identifier('{database}')" in item
            for item in statements
        )


def test_existing_installation_is_left_unchanged():
    roles = {"postgres", "scanner", "identity_service"}
    databases = {"postgres", "scanner", "scanner_test", "identity_service"}
    assert database_setup.plan(roles, databases, {}) == []


def test_partially_created_installation_only_adds_what_is_missing():
    statements = rendered(
        database_setup.plan({"postgres", "scanner"}, {"postgres", "scanner"}, PASSWORDS)
    )
    assert not any(
        "CREATE ROLE " in item and "Identifier('scanner')" in item for item in statements
    )
    assert sum("CREATE ROLE " in item for item in statements) == 1
    assert sum("CREATE DATABASE " in item for item in statements) == 2


def test_missing_password_stops_before_connecting(monkeypatch):
    monkeypatch.delenv("POSTGRES_PASSWORD", raising=False)
    monkeypatch.setattr(
        database_setup.psycopg, "connect", lambda *args, **kwargs: pytest.fail("connected")
    )
    with pytest.raises(SystemExit, match="POSTGRES_PASSWORD"):
        database_setup.main()
