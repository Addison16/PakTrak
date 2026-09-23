import json
import uuid
from datetime import timedelta

import pytest
from authlib.common.errors import AuthlibBaseError
from authlib.integrations.base_client import OAuthError
from conftest import create
from fastapi.testclient import TestClient
from httpx import ConnectError
from joserfc.errors import JoseError
from sqlalchemy import delete, func, select

from scanner import api, auth, diagnostics
from scanner.db import session_factory
from scanner.models import LoginSession, RequestErrorLog, now
from scanner.settings import get_settings


@pytest.fixture(autouse=True)
def remove_diagnostics(isolated_database):
    with session_factory()() as db:
        existing = set(db.scalars(select(RequestErrorLog.id)))
    yield
    with session_factory()() as db, db.begin():
        db.execute(delete(RequestErrorLog).where(RequestErrorLog.id.not_in(existing)))


def record_for(response):
    reference = response.headers["x-request-id"]
    with session_factory()() as db:
        record = db.get(RequestErrorLog, uuid.UUID(reference))
        assert record is not None
        return {column.name: getattr(record, column.name) for column in record.__table__.columns}


def test_validation_errors_are_actionable_redacted_and_admin_only(clients, photo, caplog):
    client, owner = clients()
    admin, _ = clients(role="admin")
    spoof = str(uuid.uuid4())
    response = client.post(
        "/api/v1/scans?ignored=secret-query",
        headers={"Idempotency-Key": "private-receipt", "X-Request-ID": spoof},
        json={
            "filename": "private-photo-name.jpg",
            "content_type": "image/jpeg",
            "size": len(photo),
            "foil_count": 33,
        },
    )
    assert response.status_code == 422
    assert response.headers["x-request-id"] != spoof
    assert response.json()["request_id"] == response.headers["x-request-id"]
    assert response.json()["detail"][0]["loc"] == ["body", "foil_count"]
    assert "at most 32" in response.json()["detail"][0]["msg"]
    row = record_for(response)
    assert row["owner_id"] == owner and row["route"] == "/api/v1/scans"
    assert row["code"] == "validation_failed"
    logged = json.dumps(row, default=str) + caplog.text
    for secret in (
        "private-photo-name",
        "secret-query",
        "private-receipt",
        client.headers["X-CSRF-Token"],
    ):
        assert secret not in logged
    url = "/api/v1/diagnostics/errors?reference=" + response.headers["x-request-id"]
    assert client.get(url).status_code == 403
    result = admin.get(url)
    assert result.status_code == 200
    assert len(result.json()["items"]) == 1
    assert result.json()["items"][0]["request_id"] == response.headers["x-request-id"]
    assert "owner_id" not in result.json()["items"][0]


def test_normal_signin_probe_is_quiet_but_expired_sessions_are_logged(clients):
    with session_factory()() as db:
        count = db.scalar(select(func.count()).select_from(RequestErrorLog))
    with TestClient(api.app, base_url=get_settings().app_url) as anonymous:
        assert anonymous.get("/api/auth/session").status_code == 401
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(RequestErrorLog)) == count
    client, owner = clients()
    with session_factory()() as db, db.begin():
        db.scalar(select(LoginSession).where(LoginSession.owner_id == owner)).expires_at = (
            now() - timedelta(seconds=1)
        )
    response = client.get("/api/auth/session")
    assert response.status_code == 401
    assert record_for(response)["code"] == "session_expired"


def test_stale_csrf_and_wrong_origin_are_distinguished_without_logging_tokens(clients, caplog):
    client, _ = clients()
    stale = client.patch(
        "/api/auth/preferences",
        headers={"X-CSRF-Token": "private-old-token"},
        json={"price_source": "manapool"},
    )
    assert stale.status_code == 403 and stale.json()["error_code"] == "csrf_mismatch"
    assert record_for(stale)["code"] == "csrf_mismatch"
    bad_origin = client.patch(
        "/api/auth/preferences",
        headers={"Origin": "https://private-origin.invalid"},
        json={"price_source": "manapool"},
    )
    assert bad_origin.status_code == 403 and record_for(bad_origin)["code"] == "origin_mismatch"
    assert "private-old-token" not in caplog.text and "private-origin" not in caplog.text
    assert client.get("/api/auth/session").json()["preferred_price_source"] is None


def test_unexpected_errors_have_reference_and_safe_code_locations(
    clients, photo, monkeypatch, caplog
):
    client, _ = clients()
    scan = create(client, photo).json()

    def broken(*args, **kwargs):
        raise RuntimeError("private-database-password and private-card-name")

    monkeypatch.setattr(api, "scan_response", broken)
    response = client.get("/api/v1/scans/" + scan["id"])
    assert response.status_code == 500
    row = record_for(response)
    assert row["route"] == "/api/v1/scans/{scan_id}"
    assert row["context"]["exception_type"] == "RuntimeError"
    assert any(frame["file"] == "api.py" for frame in row["context"]["frames"])
    assert "private-database-password" not in response.text + caplog.text
    assert "private-card-name" not in json.dumps(row, default=str)


def test_logging_failure_does_not_change_original_response(clients, photo, monkeypatch, caplog):
    client, _ = clients()

    def unavailable():
        raise OSError("private-storage-credential")

    monkeypatch.setattr(diagnostics, "log_sessions", unavailable)
    response = create(client, photo, foil_count=40)
    assert response.status_code == 422 and response.json()["error_code"] == "validation_failed"
    assert "error_log_storage_unavailable" in caplog.text
    assert "private-storage-credential" not in caplog.text


@pytest.mark.parametrize(
    "error,code",
    [
        ("invalid_grant", "login_expired"),
        ("access_denied", "login_cancelled"),
        ("unknown_provider_error", "login_verification_failed"),
    ],
)
def test_failed_login_has_safe_reference_and_no_authorization_code_in_logs(
    clients, monkeypatch, caplog, error, code
):
    client, _ = clients()

    class Provider:
        async def authorize_access_token(self, *args, **kwargs):
            raise OAuthError(error=error, description="private-identity-response")

    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: Provider())
    response = client.get(
        "/api/auth/callback?code=private-authorization-code&state=private-state",
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert "login_error=" + code in response.headers["location"]
    assert response.headers["x-request-id"] in response.headers["location"]
    assert record_for(response)["code"] == code
    for secret in ("private-identity-response", "private-authorization-code", "private-state"):
        assert secret not in caplog.text


@pytest.mark.parametrize("failure", [ConnectError, AuthlibBaseError, JoseError])
def test_identity_connection_and_signature_errors_offer_safe_signin_retry(
    clients, monkeypatch, caplog, failure
):
    client, _ = clients()

    class Provider:
        async def authorize_access_token(self, *args, **kwargs):
            raise failure("private-token-or-provider-address")

    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: Provider())
    response = client.get("/api/auth/callback", follow_redirects=False)
    assert response.status_code == 303
    assert "login_error=" in response.headers["location"]
    code = "identity_unavailable" if failure is ConnectError else "login_verification_failed"
    assert record_for(response)["code"] == code
    assert "private-token-or-provider-address" not in caplog.text + response.text


def test_logs_expire_and_are_capped(clients, monkeypatch):
    monkeypatch.setattr(diagnostics, "MAX_LOGS", 3)
    with session_factory()() as db, db.begin():
        # This database is asserted to be scanner_test by the session fixture.
        db.execute(delete(RequestErrorLog))
        ids = [uuid.uuid4() for _ in range(6)]
        for i, key in enumerate(ids):
            db.add(
                RequestErrorLog(
                    id=key,
                    created_at=now() - timedelta(days=20 if i == 0 else 0, seconds=6 - i),
                    method="GET",
                    route="/api/test",
                    status=500,
                    code="server_error",
                    summary="Synthetic",
                    duration_ms=1,
                    context={},
                )
            )
        db.flush()
        diagnostics.trim_logs(db)
        remaining = set(db.scalars(select(RequestErrorLog.id)))
        assert ids[0] not in remaining
        assert remaining == set(ids[-3:])
