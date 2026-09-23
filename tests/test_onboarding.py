import importlib.util
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi.testclient import TestClient
from sqlalchemy import text
from test_collections import catalog as catalog
from test_preferences import another_session

from scanner import auth
from scanner.api import app
from scanner.db import session_factory
from scanner.models import Binder, InventoryLot, LoginSession, User, now
from scanner.settings import get_settings


@pytest.mark.parametrize("role", ["guest", "member", "admin"])
def test_new_accounts_offer_the_tour(clients, role):
    client, owner_id = clients(role=role)
    response = client.get("/api/auth/session")
    assert response.status_code == 200
    assert response.json()["tour_dismissed"] is False
    with session_factory()() as db:
        assert db.get(User, owner_id).tour_dismissed is False


def test_dismissal_is_durable_idempotent_and_changes_only_the_tour_flag(clients, catalog):
    client, owner_id = clients(scan_cards_used=100)
    other, other_id = clients()
    with session_factory()() as db, db.begin():
        user = db.get(User, owner_id)
        user.preferred_price_source = "cardkingdom"
        binder = Binder(owner_id=owner_id, name="Existing collection", kind="binder")
        db.add(binder)
        db.flush()
        db.add(
            InventoryLot(
                owner_id=owner_id,
                binder_id=binder.id,
                printing_id=uuid.UUID(catalog[0]),
                quantity_remaining=7,
                finish="foil",
                notes="Keep this physical holding unchanged",
            )
        )
        before = {column.name: getattr(user, column.name) for column in User.__table__.columns}
    session_before = client.get("/api/auth/session").json()
    collection_before = client.get("/api/v1/collection").json()
    assert collection_before["copies"] == 7
    for _ in range(2):
        response = client.post("/api/auth/onboarding/dismiss")
        assert response.status_code == 200, response.text
        assert response.json() == {"tour_dismissed": True}
        assert response.headers["Cache-Control"] == "no-store"
        assert client.get("/api/auth/session").json() == {**session_before, "tour_dismissed": True}
        assert client.get("/api/v1/collection").json() == collection_before
    with session_factory()() as db:
        user = db.get(User, owner_id)
        assert {column.name: getattr(user, column.name) for column in User.__table__.columns} == {
            **before,
            "tour_dismissed": True,
        }
        assert db.get(User, other_id).tour_dismissed is False
    assert other.get("/api/auth/session").json()["tour_dismissed"] is False
    renewed = another_session(owner_id)
    try:
        assert renewed.get("/api/auth/session").json()["tour_dismissed"] is True
        assert renewed.post("/api/auth/onboarding/dismiss").json() == {"tour_dismissed": True}
        # Reading the session for a replay cannot reset the saved choice.
        assert renewed.get("/api/auth/session").json()["tour_dismissed"] is True
    finally:
        renewed.close()


@pytest.mark.parametrize(
    ("header", "value"),
    [
        ("X-CSRF-Token", None),
        ("X-CSRF-Token", "wrong"),
        ("Origin", None),
        ("Origin", "https://other.invalid"),
    ],
)
def test_onboarding_dismissal_requires_csrf_and_same_origin(clients, header, value):
    client, _ = clients()
    if value is None:
        del client.headers[header]
    else:
        client.headers[header] = value
    response = client.post("/api/auth/onboarding/dismiss")
    assert response.status_code == 403, response.text
    assert client.get("/api/auth/session").json()["tour_dismissed"] is False


def test_onboarding_dismissal_requires_a_current_authenticated_session(clients):
    client, owner_id = clients()
    with TestClient(app, base_url=get_settings().app_url) as anonymous:
        assert anonymous.post("/api/auth/onboarding/dismiss").status_code == 401
        anonymous.cookies.set(auth.COOKIE, "forged")
        assert anonymous.post("/api/auth/onboarding/dismiss").status_code == 401
    with session_factory()() as db, db.begin():
        session = db.get(LoginSession, auth.token_hash(client.cookies.get(auth.COOKIE)))
        session.expires_at = now() - timedelta(seconds=1)
    assert client.post("/api/auth/onboarding/dismiss").status_code == 401
    with session_factory()() as db:
        assert db.get(User, owner_id).tour_dismissed is False


def test_onboarding_dismissal_cannot_target_or_modify_another_account(clients):
    client, owner_id = clients()
    other, other_id = clients()
    response = client.post(
        "/api/auth/onboarding/dismiss",
        json={"owner_id": str(other_id), "tour_dismissed": False, "role": "admin"},
    )
    assert response.status_code == 200
    assert response.json() == {"tour_dismissed": True}
    with session_factory()() as db:
        assert db.get(User, owner_id).tour_dismissed is True
        assert db.get(User, owner_id).role == "guest"
        assert db.get(User, other_id).tour_dismissed is False
        assert db.get(User, other_id).role == "guest"
    assert other.get("/api/auth/session").json()["tour_dismissed"] is False


def test_tour_migration_preserves_existing_accounts_and_defaults_new_accounts(monkeypatch):
    path = Path("migrations/versions/67b08c53f924_account_onboarding_tour.py")
    spec = importlib.util.spec_from_file_location("onboarding_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = session_factory().kw["bind"]
    with engine.begin() as connection:
        # A connection-local temporary table shadows public.users. Exercise the
        # real PostgreSQL migration without altering the integration account table.
        connection.execute(
            text("""CREATE TEMP TABLE users (
            id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
            scan_cards_used INTEGER NOT NULL, preferred_price_source TEXT
        ) ON COMMIT DROP""")
        )
        connection.execute(
            text("""INSERT INTO users VALUES
            (1, 'Established collector', 'member', 47, 'manapool'),
            (2, 'Existing administrator', 'admin', 100, NULL)""")
        )
        assert connection.scalar(
            text("""SELECT relnamespace = pg_my_temp_schema()
            FROM pg_class WHERE oid = 'users'::regclass""")
        )
        before = connection.execute(text("SELECT * FROM users ORDER BY id")).mappings().all()
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        after = connection.execute(text("SELECT * FROM users ORDER BY id")).mappings().all()
        assert [dict(row) for row in after] == [
            {**dict(row), "tour_dismissed": True} for row in before
        ]
        assert (
            connection.scalar(
                text("""INSERT INTO users
            (id, display_name, role, scan_cards_used) VALUES (3, 'New collector', 'guest', 0)
            RETURNING tour_dismissed""")
            )
            is False
        )
