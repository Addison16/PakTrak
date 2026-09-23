import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from scanner import auth
from scanner.api import app
from scanner.db import session_factory
from scanner.models import LoginSession, User, now
from scanner.settings import get_settings


def another_session(owner_id):
    token, csrf = secrets.token_urlsafe(32), secrets.token_hex(32)
    with session_factory()() as db, db.begin():
        db.add(
            LoginSession(
                owner_id=owner_id,
                token_hash=auth.token_hash(token),
                csrf_token=csrf,
                expires_at=now() + timedelta(hours=1),
            )
        )
    client = TestClient(app, base_url=get_settings().app_url)
    client.cookies.set(auth.COOKIE, token)
    client.headers.update({"Origin": get_settings().app_url, "X-CSRF-Token": csrf})
    return client


@pytest.mark.parametrize("role", ["guest", "member", "admin"])
def test_price_preference_is_account_saved_and_visible_in_another_session(clients, role):
    client, owner_id = clients(role=role, scan_cards_used=23)
    stranger, stranger_id = clients()
    initial = client.get("/api/auth/session").json()
    assert initial["preferred_price_source"] is None
    second = another_session(owner_id)
    try:
        for source in ["cardkingdom", "manapool", "tcgplayer"]:
            response = client.patch("/api/auth/preferences", json={"price_source": source})
            assert response.status_code == 200, response.text
            assert response.json() == {"preferred_price_source": source}
            assert response.headers["Cache-Control"] == "no-store"
            assert client.get("/api/auth/session").json() == {
                **initial,
                "preferred_price_source": source,
            }
            assert second.get("/api/auth/session").json()["preferred_price_source"] == source
            assert stranger.get("/api/auth/session").json()["preferred_price_source"] is None
            with session_factory()() as db:
                assert db.get(User, owner_id).preferred_price_source == source
                assert db.get(User, stranger_id).preferred_price_source is None
        # A fresh login session reads the durable account field, not a session copy.
        renewed = another_session(owner_id)
        try:
            assert renewed.get("/api/auth/session").json()["preferred_price_source"] == "tcgplayer"
            renewed.patch("/api/auth/preferences", json={"price_source": "manapool"})
            assert client.get("/api/auth/session").json()["preferred_price_source"] == "manapool"
        finally:
            renewed.close()
    finally:
        second.close()


def test_oidc_account_refresh_preserves_saved_preference(clients):
    client, owner_id = clients()
    assert (
        client.patch("/api/auth/preferences", json={"price_source": "cardkingdom"}).status_code
        == 200
    )
    with session_factory()() as db, db.begin():
        user = db.get(User, owner_id)
        user.issuer = get_settings().oidc_issuer
        subject = user.subject
    with session_factory()() as db, db.begin():
        user = auth.save_account(db, subject, "Renamed collector")
        assert user.id == owner_id
        assert user.preferred_price_source == "cardkingdom"
    info = client.get("/api/auth/session").json()
    assert info["display_name"] == "Renamed collector"
    assert info["preferred_price_source"] == "cardkingdom"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"price_source": None},
        {"price_source": "unknown"},
        {"price_source": "TCGplayer"},
        {"price_source": ["tcgplayer"]},
        {"price_source": "manapool", "owner_id": "another-account"},
        {"price_source": "manapool", "role": "admin"},
        {"price_source": "manapool", "only_if_unset": "false"},
    ],
)
def test_invalid_preferences_do_not_replace_the_saved_choice(clients, body):
    client, owner_id = clients()
    client.patch("/api/auth/preferences", json={"price_source": "cardkingdom"})
    response = client.patch("/api/auth/preferences", json=body)
    assert response.status_code == 422, response.text
    with session_factory()() as db:
        user = db.get(User, owner_id)
        assert user.preferred_price_source == "cardkingdom"
        assert user.role == "guest"


@pytest.mark.parametrize(
    ("header", "value"),
    [
        ("X-CSRF-Token", None),
        ("X-CSRF-Token", "wrong"),
        ("Origin", None),
        ("Origin", "https://other.invalid"),
    ],
)
def test_price_preference_requires_csrf_token_and_same_origin(clients, header, value):
    client, _ = clients()
    if value is None:
        del client.headers[header]
    else:
        client.headers[header] = value
    response = client.patch("/api/auth/preferences", json={"price_source": "manapool"})
    assert response.status_code == 403, response.text
    assert client.get("/api/auth/session").json()["preferred_price_source"] is None


def test_price_preference_requires_a_current_authenticated_session(clients):
    client, owner_id = clients()
    with TestClient(app, base_url=get_settings().app_url) as anonymous:
        assert anonymous.get("/api/auth/session").status_code == 401
        assert (
            anonymous.patch("/api/auth/preferences", json={"price_source": "manapool"}).status_code
            == 401
        )
        anonymous.cookies.set(auth.COOKIE, "forged")
        assert (
            anonymous.patch("/api/auth/preferences", json={"price_source": "manapool"}).status_code
            == 401
        )
    with session_factory()() as db, db.begin():
        session = db.get(LoginSession, auth.token_hash(client.cookies.get(auth.COOKIE)))
        session.expires_at = now() - timedelta(seconds=1)
    assert (
        client.patch("/api/auth/preferences", json={"price_source": "manapool"}).status_code == 401
    )
    with session_factory()() as db:
        assert db.get(User, owner_id).preferred_price_source is None


def test_legacy_device_migration_cannot_overwrite_a_saved_account_choice(clients):
    client, owner_id = clients()
    second = another_session(owner_id)
    try:
        legacy = {"price_source": "cardkingdom", "only_if_unset": True}
        assert client.patch("/api/auth/preferences", json=legacy).json() == {
            "preferred_price_source": "cardkingdom"
        }
        assert (
            second.patch("/api/auth/preferences", json={"price_source": "manapool"}).status_code
            == 200
        )
        # This device still believes its first session response (null), but the
        # saved explicit choice must win over that stale migration request.
        assert client.patch("/api/auth/preferences", json=legacy).json() == {
            "preferred_price_source": "manapool"
        }
        assert second.get("/api/auth/session").json()["preferred_price_source"] == "manapool"
    finally:
        second.close()


def test_concurrent_device_migrations_choose_one_durable_account_preference(clients):
    client, owner_id = clients()
    second = another_session(owner_id)
    barrier = threading.Barrier(2)

    def migrate(args):
        browser, source = args
        barrier.wait(timeout=5)
        result = browser.patch(
            "/api/auth/preferences", json={"price_source": source, "only_if_unset": True}
        )
        assert result.status_code == 200, result.text
        return result.json()["preferred_price_source"]

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            saved = list(pool.map(migrate, [(client, "cardkingdom"), (second, "manapool")]))
        assert saved[0] == saved[1]
        assert saved[0] in {"cardkingdom", "manapool"}
        assert client.get("/api/auth/session").json()["preferred_price_source"] == saved[0]
    finally:
        second.close()


def test_database_rejects_unsupported_price_sources(clients):
    _, owner_id = clients()
    with session_factory()() as db, pytest.raises(IntegrityError):
        db.get(User, owner_id).preferred_price_source = "unsupported"
        db.commit()
