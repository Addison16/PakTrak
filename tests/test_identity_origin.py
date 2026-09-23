"""A hostname move must preserve owners, privileges and data, without identity guessing."""

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from conftest import create
from pydantic import SecretStr
from sqlalchemy import delete, func, select

from scanner import auth, bootstrap
from scanner.db import session_factory
from scanner.identity_origin import IdentityConfigurationError, bind_origin
from scanner.models import (
    Binder,
    CatalogSnapshot,
    Deck,
    IdentityBinding,
    InventoryLot,
    LoginSession,
    Printing,
    Scan,
    User,
)
from scanner.settings import get_settings

OLD = "https://old.example.invalid/identity/realms/scanner"
REALM = "test-stable-local-realm"


@pytest.fixture(scope="session")
def origin_catalog(isolated_database):
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(source="origin-test", checksum=uuid.uuid4().hex, printings=1)
        db.add(snapshot)
        db.flush()
        printing = Printing(
            id=uuid.uuid4(),
            name="Synthetic Origin Fixture",
            set_code="ori",
            collector_number="1",
            language="en",
            finishes=["nonfoil"],
            source_json={},
            snapshot_id=snapshot.id,
        )
        db.add(printing)
        snapshot_id, printing_id = snapshot.id, printing.id
    yield printing_id
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id == printing_id))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


@pytest.fixture(autouse=True)
def binding(isolated_database):
    with session_factory()() as db:
        assert db.get(IdentityBinding, 1) is None
    yield
    with session_factory()() as db, db.begin():
        db.execute(delete(IdentityBinding))


def set_issuer(owner, issuer):
    with session_factory()() as db, db.begin():
        db.get(User, owner).issuer = issuer


def bind(issuer, realm=REALM):
    with session_factory()() as db, db.begin():
        return bind_origin(db, realm, issuer)


@pytest.fixture
def provider(monkeypatch):
    settings = get_settings().model_copy(
        update={
            "identity_admin_password": SecretStr("bootstrap-fixture-only"),
            "password_reset_client_secret": SecretStr("reset-fixture-only" * 4),
        }
    )
    state = {
        "realm": {
            "id": REALM,
            "passwordPolicy": "length(12) and notUsername(undefined)",
            "attributes": {"keep": "realm-setting"},
        },
        "client": {
            "id": "login-client-id",
            "clientId": settings.oidc_client_id,
            "redirectUris": ["https://old.example.invalid/api/auth/callback"],
            "attributes": {"keep": "client-setting"},
        },
        "writes": [],
        "failure": None,
        "discovery": settings.oidc_issuer,
        "reset_calls": 0,
    }

    def respond(request):
        path = request.url.path
        if request.method == "POST" and path.endswith(
            "/realms/master/protocol/openid-connect/token"
        ):
            return httpx.Response(200, json={"access_token": "fixture-token"})
        assert request.headers.get("Authorization") == "Bearer fixture-token" or path.endswith(
            "/.well-known/openid-configuration"
        )
        if request.method == "GET":
            if path.endswith("/admin/realms/scanner"):
                return httpx.Response(200, json=state["realm"])
            if path.endswith("/clients"):
                return httpx.Response(200, json=[state["client"]])
            if path.endswith("/client-scopes"):
                return httpx.Response(200, json=[{"id": "basic-id", "name": "basic"}])
            if path.endswith("/.well-known/openid-configuration"):
                return httpx.Response(200, json={"issuer": state["discovery"]})
        if request.method == "PUT":
            payload = json.loads(request.content) if request.content else None
            state["writes"].append((path, payload))
            if state["failure"] and path.endswith(state["failure"]):
                return httpx.Response(503)
            if path.endswith("/admin/realms/scanner"):
                state["realm"].update(payload)
            elif path.endswith("/clients/login-client-id"):
                state["client"].update(payload)
            elif not path.endswith("/default-client-scopes/basic-id"):
                raise AssertionError(path)
            return httpx.Response(204)
        raise AssertionError((request.method, path))

    def reset_client(*args):
        state["reset_calls"] += 1

    monkeypatch.setattr(bootstrap, "get_settings", lambda: settings)
    monkeypatch.setattr(bootstrap, "configure_reset_client", reset_client)
    monkeypatch.setattr(
        bootstrap,
        "httpx",
        SimpleNamespace(
            Client=lambda **kwargs: httpx.Client(transport=httpx.MockTransport(respond), **kwargs)
        ),
    )
    return state, settings


def test_first_boot_and_repeat_preserve_existing_accounts_and_sessions(clients, provider):
    client, owner = clients(role="admin", scan_cards_used=215)
    set_issuer(owner, get_settings().oidc_issuer)
    before = client.get("/api/auth/session").json()
    bootstrap.configure_registration()
    with session_factory()() as db:
        stamp = db.get(IdentityBinding, 1).updated_at
    bootstrap.configure_registration()
    assert client.get("/api/auth/session").json() == before
    with session_factory()() as db:
        saved = db.get(IdentityBinding, 1)
        assert saved.realm_id == REALM and saved.issuer == get_settings().oidc_issuer
        assert saved.updated_at == stamp
        assert db.scalar(select(func.count()).select_from(User)) == 1
    state, settings = provider
    assert state["realm"]["passwordPolicy"] == "length(8) and notUsername(undefined)"
    assert state["realm"]["attributes"] == {
        "keep": "realm-setting",
        "frontendUrl": settings.app_url + "/identity",
    }
    assert state["client"]["redirectUris"] == [settings.app_url + "/api/auth/callback"]
    assert state["client"]["webOrigins"] == [settings.app_url]
    assert state["client"]["attributes"] == {
        "keep": "client-setting",
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": settings.app_url + "/",
    }
    assert state["reset_calls"] == 2


def test_subdomain_change_keeps_collection_decks_scans_roles_limits_and_account_ids(
    clients, provider, origin_catalog, photo
):
    admin, owner = clients(role="admin", scan_cards_used=215)
    _, member = clients(role="member", scan_cards_used=86)
    for identifier in (owner, member):
        set_issuer(identifier, OLD)
    scan_id = uuid.UUID(create(admin, photo).json()["id"])
    with session_factory()() as db, db.begin():
        user = db.get(User, owner)
        user.preferred_price_source = "manapool"
        member_user = db.get(User, member)
        member_user.scan_card_limit_override = 500
        member_user.scans_paused = True
        member_user.suspended = True
        binder = Binder(owner_id=owner, name="Red binder")
        deck = Deck(
            owner_id=owner, request_key="origin-test", request_hash="a" * 64, name="Keep this deck"
        )
        db.add_all([binder, deck])
        db.flush()
        lot = InventoryLot(
            owner_id=owner,
            binder_id=binder.id,
            printing_id=origin_catalog,
            quantity_remaining=30,
            finish="nonfoil",
        )
        db.add(lot)
        db.flush()
        lot_id, deck_id, binder_id = lot.id, deck.id, binder.id
        original = {
            u.id: {c.name: getattr(u, c.name) for c in User.__table__.columns if c.name != "issuer"}
            for u in (user, member_user)
        }
    assert bind(OLD) == 0
    bootstrap.configure_registration()
    assert admin.get("/api/auth/session").status_code == 401
    with session_factory()() as db, db.begin():
        assert db.scalar(select(func.count()).select_from(User)) == 2
        for owner_id, expected in original.items():
            user = db.get(User, owner_id)
            assert user.issuer == get_settings().oidc_issuer
            assert {
                c.name: getattr(user, c.name) for c in User.__table__.columns if c.name != "issuer"
            } == expected
            assert auth.save_account(db, user.subject, user.display_name).id == owner_id
        assert db.get(InventoryLot, lot_id).quantity_remaining == 30
        assert db.get(InventoryLot, lot_id).binder_id == binder_id
        assert db.get(Deck, deck_id).owner_id == owner
        assert db.get(Scan, scan_id).owner_id == owner
        assert db.scalar(select(func.count()).select_from(LoginSession)) == 0
    bootstrap.configure_registration()
    with session_factory()() as db:
        assert db.get(IdentityBinding, 1).issuer == get_settings().oidc_issuer


def test_successive_moves_and_return_to_original_address_keep_one_owner(clients):
    _, owner = clients(role="admin")
    set_issuer(owner, OLD)
    assert bind(OLD) == 0
    for issuer in [
        get_settings().oidc_issuer,
        "https://third.example.invalid/identity/realms/scanner",
        OLD,
    ]:
        assert bind(issuer) == 1
        assert bind(issuer) == 0
        with session_factory()() as db:
            assert db.get(User, owner).issuer == issuer
            assert db.get(User, owner).role == "admin"
            assert db.scalar(select(func.count()).select_from(User)) == 1


def test_different_realm_stops_before_provider_writes_or_account_changes(clients, provider):
    client, owner = clients(role="admin")
    set_issuer(owner, OLD)
    bind(OLD)
    provider[0]["realm"]["id"] = "a-different-identity-database"
    with pytest.raises(IdentityConfigurationError, match="realm has changed"):
        bootstrap.configure_registration()
    assert provider[0]["writes"] == []
    assert client.get("/api/auth/session").status_code == 200
    with session_factory()() as db:
        assert db.get(User, owner).issuer == OLD
        assert db.get(IdentityBinding, 1).realm_id == REALM


@pytest.mark.parametrize("existing_binding", [False, True])
def test_unknown_legacy_issuer_or_duplicate_is_not_guessed_or_merged(
    clients, provider, existing_binding
):
    _, owner = clients(role="admin")
    set_issuer(owner, OLD)
    if existing_binding:
        bind(OLD)
        _, duplicate_id = clients()
        with session_factory()() as db, db.begin():
            original, duplicate = db.get(User, owner), db.get(User, duplicate_id)
            duplicate.subject = original.subject
            duplicate.issuer = get_settings().oidc_issuer
    with pytest.raises(IdentityConfigurationError, match="unrecognized sign-in address"):
        bootstrap.configure_registration()
    assert provider[0]["writes"] == []
    with session_factory()() as db:
        assert db.get(User, owner).issuer == OLD
        assert db.scalar(select(func.count()).select_from(User)) == (2 if existing_binding else 1)


@pytest.mark.parametrize(
    "failure", ["/clients/login-client-id", "/default-client-scopes/basic-id", "discovery"]
)
def test_provider_failure_rolls_back_account_move_and_retry_finishes(clients, provider, failure):
    client, owner = clients(role="admin")
    set_issuer(owner, OLD)
    bind(OLD)
    state, settings = provider
    if failure == "discovery":
        state["discovery"] = OLD
    else:
        state["failure"] = failure
    with pytest.raises((httpx.HTTPStatusError, RuntimeError)):
        bootstrap.configure_registration()
    with session_factory()() as db:
        assert db.get(User, owner).issuer == OLD
        assert db.get(IdentityBinding, 1).issuer == OLD
    assert client.get("/api/auth/session").status_code == 200
    state["failure"], state["discovery"] = None, settings.oidc_issuer
    bootstrap.configure_registration()
    with session_factory()() as db:
        assert db.get(User, owner).issuer == settings.oidc_issuer
        assert db.get(User, owner).role == "admin"
    assert client.get("/api/auth/session").status_code == 401


def test_callback_from_process_with_old_configuration_cannot_create_duplicate(clients, monkeypatch):
    client, owner = clients(role="admin")
    set_issuer(owner, OLD)
    bind(OLD)
    with session_factory()() as db:
        subject = db.get(User, owner).subject

    class Provider:
        async def authorize_access_token(self, request, **kwargs):
            return {
                "userinfo": {
                    "iss": get_settings().oidc_issuer,
                    "sub": subject,
                    "preferred_username": "Test collector",
                }
            }

    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: Provider())
    response = client.get("/api/auth/callback", follow_redirects=False)
    assert response.status_code == 303
    assert "login_error=login_address_changed" in response.headers["location"]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert db.get(User, owner).role == "admin"


@pytest.mark.parametrize("realm", [None, "", 123, "x" * 256])
def test_missing_realm_identifier_cannot_authorize_an_origin_move(realm):
    with pytest.raises(IdentityConfigurationError, match="valid realm ID"):
        bind(OLD, realm=realm)
    with session_factory()() as db:
        assert db.get(IdentityBinding, 1) is None
