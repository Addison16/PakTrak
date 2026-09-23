"""Credential resets use scoped provider access and cannot resurrect old sign-ins."""

import json
import uuid
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import func, select
from starlette.responses import RedirectResponse

from scanner import auth, identity_admin
from scanner.api import app
from scanner.db import session_factory
from scanner.models import AccountEvent, LoginSession, RequestErrorLog, User, now
from scanner.settings import get_settings


@pytest.fixture
def provider(monkeypatch):
    state = {"calls": [], "failure": None, "required": [], "password": None}
    monkeypatch.setattr(
        get_settings(),
        "password_reset_client_secret",
        SecretStr("fixture-service-secret-" + "x" * 32),
    )
    original = httpx.Client

    def handle(request):
        state["calls"].append((request.method, request.url.path))
        if request.url.path.endswith("/token"):
            if state["failure"] == "token":
                return httpx.Response(403, json={"error": "private upstream contents"})
            assert b"grant_type=client_credentials" in request.content
            return httpx.Response(200, json={"access_token": "fixture-access-token"})
        assert request.headers["Authorization"] == "Bearer fixture-access-token"
        if request.method == "GET":
            if state["failure"] == "user":
                return httpx.Response(404)
            return httpx.Response(
                200,
                json={
                    "id": request.url.path.rsplit("/", 1)[1],
                    "username": "collector-login",
                    "requiredActions": state["required"],
                },
            )
        if request.url.path.endswith("/logout"):
            return httpx.Response(503 if state["failure"] == "logout" else 204)
        assert request.url.path.endswith("/reset-password") and request.method == "PUT"
        payload = json.loads(request.content)
        assert payload["type"] == "password" and payload["temporary"] is True
        state["password"] = payload["value"]
        if state["failure"] == "crash":
            raise RuntimeError("simulated process interruption")
        if state["failure"] == "timeout":
            raise httpx.ReadTimeout("fixture private response must not be logged", request=request)
        if state["failure"] == "policy":
            return httpx.Response(
                400, json={"error": "private upstream contents", "secret": payload["value"]}
            )
        state["required"] = ["UPDATE_PASSWORD"]
        return httpx.Response(204)

    monkeypatch.setattr(
        identity_admin.httpx,
        "Client",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    return state


def local_identity(owner):
    with session_factory()() as db, db.begin():
        user = db.get(User, owner)
        user.issuer, user.subject = get_settings().oidc_issuer, str(uuid.uuid4())
        return user.subject


def reset(admin, owner, version=1, **kwargs):
    return admin.post(
        f"/api/auth/accounts/{owner}/reset-password", json={"expected_version": version}, **kwargs
    )


def events(owner):
    with session_factory()() as db:
        return list(
            db.scalars(
                select(AccountEvent.kind)
                .where(AccountEvent.owner_id == owner)
                .order_by(AccountEvent.created_at)
            )
        )


def test_reset_is_admin_only_csrf_checked_and_never_resets_an_admin(clients, provider):
    admin, admin_id = clients(role="admin")
    member, owner = clients(role="member")
    local_identity(owner)
    with TestClient(app, base_url=get_settings().app_url) as visitor:
        assert reset(visitor, owner).status_code == 401
    assert reset(member, owner).status_code == 403
    assert reset(admin, owner, headers={"X-CSRF-Token": "bad"}).status_code == 403
    assert reset(admin, owner, headers={"Origin": "https://foreign.invalid"}).status_code == 403
    assert reset(admin, admin_id).status_code == 403
    assert reset(admin, uuid.uuid4()).status_code == 404
    assert reset(admin, owner, version=2).status_code == 409
    assert provider["calls"] == []
    assert member.get("/api/auth/session").status_code == 200


def test_reset_targets_only_the_account_identity_and_returns_secret_once(clients, provider, caplog):
    admin, admin_id = clients(role="admin")
    member, owner = clients(role="member", scan_cards_used=217)
    local_identity(owner)
    response = reset(admin, owner)
    assert response.status_code == 200, response.text
    result = response.json()
    password = result["temporary_password"]
    assert len(password) >= 20 and password == provider["password"]
    assert result["username"] == "collector-login"
    assert response.headers["Cache-Control"] == "no-store"
    assert result["account"]["active_sessions"] == 0
    assert result["account"]["scan_cards_used"] == 217
    assert result["account"]["scan_card_limit"] is None
    assert result["account"]["password_reset_pending"] is False
    assert member.get("/api/auth/session").status_code == 401
    assert reset(admin, owner).status_code == 409
    assert sum(path.endswith("/reset-password") for _, path in provider["calls"]) == 1
    assert events(owner) == ["PASSWORD_RESET_STARTED", "PASSWORD_RESET"]
    saved = admin.get(f"/api/auth/accounts/{owner}")
    assert password not in saved.text and "temporary_password" not in saved.text
    with session_factory()() as db:
        assert all(
            event.actor_id == admin_id and event.detail == {}
            for event in db.scalars(select(AccountEvent).where(AccountEvent.owner_id == owner))
        )
        log = str(
            [
                entry.context
                for entry in db.scalars(
                    select(RequestErrorLog).where(RequestErrorLog.owner_id == admin_id)
                )
            ]
        )
        assert password not in log
    assert password not in caplog.text and "fixture-service-secret" not in caplog.text


@pytest.mark.parametrize("role", ["guest", "member"])
def test_reset_preserves_suspension_scan_pause_and_lifetime_cap(clients, provider, role):
    admin, _ = clients(role="admin")
    _, owner = clients(role=role, scan_cards_used=75)
    local_identity(owner)
    with session_factory()() as db, db.begin():
        user = db.get(User, owner)
        user.suspended, user.scans_paused, user.scan_card_limit_override = True, True, 125
    result = reset(admin, owner).json()["account"]
    assert result["suspended"] and result["scans_paused"] and result["role"] == role
    assert result["scan_cards_used"] == 75 and result["scan_cards_remaining"] == 50


@pytest.mark.parametrize("failure", ["token", "user"])
def test_preflight_failure_leaves_credentials_and_sessions_alone(clients, provider, failure):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    local_identity(owner)
    provider["failure"] = failure
    response = reset(admin, owner)
    assert response.status_code == 503
    assert "private upstream" not in response.text
    assert member.get("/api/auth/session").status_code == 200
    assert events(owner) == []
    assert provider["password"] is None


@pytest.mark.parametrize("failure", ["logout", "policy", "timeout"])
def test_incomplete_reset_revokes_app_sessions_and_allows_an_explicit_retry(
    clients, provider, failure, caplog
):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    local_identity(owner)
    provider["failure"] = failure
    response = reset(admin, owner)
    assert response.status_code == 503
    assert "could not be confirmed" in response.json()["detail"]
    assert "private upstream" not in response.text and "fixture private" not in caplog.text
    assert member.get("/api/auth/session").status_code == 401
    assert events(owner) == ["PASSWORD_RESET_STARTED", "PASSWORD_RESET_FAILED"]
    current = admin.get(f"/api/auth/accounts/{owner}").json()
    assert current["password_reset_pending"] is False
    provider["failure"] = None
    retried = reset(admin, owner, current["account_version"])
    assert retried.status_code == 200


def test_interrupted_reset_stays_fenced_until_admin_retries(clients, provider):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    local_identity(owner)
    provider["failure"] = "crash"
    assert reset(admin, owner).status_code == 500
    current = admin.get(f"/api/auth/accounts/{owner}").json()
    assert current["password_reset_pending"] is True
    assert member.get("/api/auth/session").status_code == 401
    provider["failure"] = None
    assert (
        reset(admin, owner, current["account_version"]).json()["account"]["password_reset_pending"]
        is False
    )


def test_reset_rejects_foreign_issuers_and_does_not_accept_a_client_password(clients, provider):
    admin, _ = clients(role="admin")
    _, owner = clients(role="member")
    assert reset(admin, owner).status_code == 409
    assert provider["calls"] == []
    local_identity(owner)
    assert (
        admin.post(
            f"/api/auth/accounts/{owner}/reset-password",
            json={"expected_version": 1, "password": "not-accepted"},
        ).status_code
        == 422
    )
    assert provider["calls"] == []


def test_callback_requires_fresh_authentication_and_finished_password_change(
    clients, provider, monkeypatch
):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    subject = local_identity(owner)
    stamp = int((now() - timedelta(minutes=5)).timestamp())

    class LoginProvider:
        async def authorize_redirect(self, request, uri, state, **kwargs):
            return RedirectResponse("/test-provider?state=" + state)

        async def authorize_access_token(self, request, **kwargs):
            return {
                "userinfo": {
                    "iss": get_settings().oidc_issuer,
                    "sub": subject,
                    "preferred_username": "collector-login",
                    "auth_time": stamp,
                }
            }

    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: LoginProvider())
    assert reset(admin, owner).status_code == 200

    def login():
        first = member.get("/api/auth/login", follow_redirects=False)
        state = first.headers["location"].split("state=")[1]
        return member.get("/api/auth/callback?state=" + state, follow_redirects=False)

    assert login().headers["location"] == "/api/auth/login?fresh=true"
    stamp = int(now().timestamp())
    assert login().headers["location"] == "/api/auth/login?fresh=true"
    with session_factory()() as db:
        assert (
            db.scalar(
                select(func.count()).select_from(LoginSession).where(LoginSession.owner_id == owner)
            )
            == 0
        )
    provider["required"] = []
    assert login().headers["location"] == "/"
    assert member.get("/api/auth/session").status_code == 200
    with session_factory()() as db, db.begin():
        db.get(User, owner).password_reset_pending = True
    assert member.get("/api/auth/session").json()["error_code"] == "password_reset_pending"
    assert "password_reset_pending" in login().headers["location"]
