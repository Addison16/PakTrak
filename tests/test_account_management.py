"""Access controls are enforced on the server and preserve lifetime card usage."""

import secrets
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from conftest import accept, create, upload
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from starlette.responses import RedirectResponse
from test_accounts_library import image_result
from test_collections import commit, key, preview
from test_scan_batches import approve, deletion, prepared

from scanner import auth, storage
from scanner.api import app
from scanner.db import session_factory
from scanner.models import (
    AccountEvent,
    CatalogSnapshot,
    Job,
    LoginSession,
    Observation,
    Printing,
    Scan,
    User,
    now,
)
from scanner.settings import get_settings
from scanner.worker import claim, finish


@pytest.fixture(scope="session")
def account_catalog(isolated_database):
    # Unique metadata avoids ambiguous names in other modules' session fixtures.
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="account policy fixture", checksum=secrets.token_hex(32), printings=1
        )
        db.add(snapshot)
        db.flush()
        printing = Printing(
            id=uuid.uuid4(),
            name="Account Policy Fixture",
            set_code="acp",
            collector_number="1",
            language="en",
            finishes=["nonfoil"],
            snapshot_id=snapshot.id,
            source_json={},
        )
        db.add(printing)
        ids, snapshot_id = [str(printing.id)], snapshot.id
    yield ids
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_([uuid.UUID(value) for value in ids])))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def policy(admin, owner, **changes):
    current = admin.get(f"/api/auth/accounts/{owner}").json()
    data = {
        field: current[field] for field in ("suspended", "scans_paused", "scan_card_limit_override")
    }
    data.update(expected_version=current["account_version"], **changes)
    result = admin.post(f"/api/auth/accounts/{owner}/access", json=data)
    assert result.status_code == 200, result.text
    return result.json()


def extra_session(owner):
    raw, csrf = secrets.token_urlsafe(32), secrets.token_hex(32)
    with session_factory()() as db, db.begin():
        db.add(
            LoginSession(
                owner_id=owner,
                token_hash=auth.token_hash(raw),
                csrf_token=csrf,
                expires_at=now() + timedelta(hours=1),
            )
        )
    client = TestClient(app, base_url=get_settings().app_url)
    client.cookies.set(auth.COOKIE, raw)
    client.headers.update({"Origin": get_settings().app_url, "X-CSRF-Token": csrf})
    return client


def provider(monkeypatch, owner):
    with session_factory()() as db, db.begin():
        user = db.get(User, owner)
        user.issuer = get_settings().oidc_issuer
        state = {"subject": user.subject, "options": {}}

    class Provider:
        async def authorize_redirect(self, request, uri, state, **kwargs):
            values["options"] = kwargs
            return RedirectResponse("/test-provider?state=" + state)

        async def authorize_access_token(self, request, **kwargs):
            return {
                "userinfo": {
                    "iss": get_settings().oidc_issuer,
                    "sub": values["subject"],
                    "preferred_username": "Sign-in username",
                }
            }

    values = state
    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: Provider())
    return values


def login(client, flow="login"):
    start = client.get("/api/auth/" + flow, follow_redirects=False)
    assert start.status_code == 307
    state = start.headers["location"].split("state=")[1]
    return client.get("/api/auth/callback?state=" + state, follow_redirects=False)


def test_profile_is_private_versioned_and_survives_next_login(clients, monkeypatch):
    member, owner = clients(role="member", scan_cards_used=137)
    stranger, other = clients()
    provider(monkeypatch, owner)
    current = member.get("/api/auth/me").json()
    assert current["id"] == str(owner)
    assert current["scan_card_limit"] is None and current["active_sessions"] == 1
    assert current["collection_copies"] == current["saved_decks"] == current["saved_batches"] == 0
    data = {"expected_version": current["account_version"], "display_name": "  Box keeper  "}
    for invalid in ["   ", "", "a" * 81]:
        assert (
            member.patch("/api/auth/me", json={**data, "display_name": invalid}).status_code == 422
        )
    for field, value in {
        "role": "admin",
        "owner_id": str(other),
        "scan_cards_used": 0,
        "suspended": False,
    }.items():
        assert member.patch("/api/auth/me", json={**data, field: value}).status_code == 422
    assert (
        member.patch("/api/auth/me", json=data, headers={"X-CSRF-Token": "bad"}).status_code == 403
    )
    saved = member.patch("/api/auth/me", json=data).json()
    assert saved["display_name"] == "Box keeper" and saved["scan_cards_used"] == 137
    assert saved["activity"][0]["kind"] == "PROFILE_UPDATED"
    assert member.patch("/api/auth/me", json=data).status_code == 409
    assert stranger.get(f"/api/auth/accounts/{owner}").status_code == 403
    assert stranger.get("/api/auth/me").json()["display_name"] == "Test collector"
    assert login(member).headers["location"] == "/"
    assert member.get("/api/auth/session").json()["display_name"] == "Box keeper"
    assert not {"subject", "issuer", "csrf_token", "token_hash"}.intersection(saved)


def test_access_requires_admin_csrf_fresh_version_and_protects_admins(clients):
    admin, admin_id = clients(role="admin")
    other_admin, other_admin_id = clients(role="admin")
    member, owner = clients(role="member")
    data = {
        "expected_version": 1,
        "suspended": False,
        "scans_paused": True,
        "scan_card_limit_override": 0,
    }
    path = f"/api/auth/accounts/{owner}/access"
    assert member.post(path, json=data).status_code == 403
    assert (
        member.post(f"/api/auth/accounts/{owner}/signout", json={"expected_version": 1}).status_code
        == 403
    )
    assert admin.post(path, json=data, headers={"X-CSRF-Token": "bad"}).status_code == 403
    assert (
        admin.post(path, json=data, headers={"Origin": "https://untrusted.invalid"}).status_code
        == 403
    )
    for bad in [-1, True, 1.5, "100", 1_000_000_001]:
        assert admin.post(path, json={**data, "scan_card_limit_override": bad}).status_code == 422
    assert admin.post(path, json={**data, "scans_paused": "true"}).status_code == 422
    for protected in [admin_id, other_admin_id]:
        assert admin.post(f"/api/auth/accounts/{protected}/access", json=data).status_code == 403
        assert (
            admin.post(
                f"/api/auth/accounts/{protected}/signout", json={"expected_version": 1}
            ).status_code
            == 403
        )
    saved = admin.post(path, json=data).json()
    assert saved["account_version"] == 2 and saved["scan_cards_remaining"] == 0
    assert admin.post(path, json={**data, "scans_paused": False}).status_code == 409
    assert admin.post(f"/api/auth/accounts/{uuid.uuid4()}/access", json=data).status_code == 404
    assert other_admin.get("/api/auth/session").status_code == 200
    with session_factory()() as db:
        event = db.scalar(select(AccountEvent).where(AccountEvent.owner_id == owner))
        assert event.actor_id == admin_id
        assert event.detail == {
            "changes": {
                "scans_paused": {"before": False, "after": True},
                "scan_card_limit_override": {"before": None, "after": 0},
            }
        }


def test_approval_restores_unlimited_once_and_never_resets_lifetime_usage(clients, photo):
    admin, _ = clients(role="admin")
    guest, owner = clients(scan_cards_used=100)
    assert guest.get("/api/auth/me").json()["scan_card_limit"] == 100
    policy(admin, owner, scan_card_limit_override=200)
    approved = admin.post(f"/api/auth/accounts/{owner}/approve").json()
    assert approved["role"] == "member" and approved["scan_card_limit"] is None
    assert approved["scan_card_limit_override"] is None and approved["scan_cards_used"] == 100
    policy(admin, owner, scan_card_limit_override=100)
    assert create(guest, photo).status_code == 403
    assert admin.post(f"/api/auth/accounts/{owner}/approve").json()["scan_card_limit"] == 100
    raised = policy(admin, owner, scan_card_limit_override=101)
    assert raised["scan_cards_remaining"] == 1
    assert create(guest, photo).status_code == 201
    policy(admin, owner, scan_card_limit_override=0)
    assert create(guest, photo).status_code == 403
    restored = policy(admin, owner, scan_card_limit_override=None)
    assert restored["scan_card_limit"] is None and restored["scan_cards_used"] == 100
    assert create(guest, photo).status_code == 201


def test_pause_rechecks_upload_and_finalize_but_accepted_work_finishes(clients, photo):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    waiting = create(member, photo).json()["id"]
    uploaded = upload(member, photo)
    queued = upload(member, photo)
    claimed = claim(uuid.UUID(accept(member, queued)["job_id"]))
    policy(admin, owner, scans_paused=True)
    assert create(member, photo).status_code == 403
    assert (
        member.put(
            f"/api/v1/scans/{waiting}/upload", content=photo, headers={"Content-Type": "image/jpeg"}
        ).status_code
        == 403
    )
    assert member.post(f"/api/v1/scans/{uploaded}/finalize", headers=key()).status_code == 403
    assert accept(member, queued)["job_id"] == str(claimed["id"])
    assert finish(claimed, image_result(3))
    assert member.get("/api/auth/me").json()["scan_cards_used"] == 3
    assert member.get("/api/v1/decks").status_code == 200
    policy(admin, owner, scans_paused=False)
    assert member.post(f"/api/v1/scans/{uploaded}/finalize", headers=key()).status_code == 202


@pytest.mark.parametrize("change", ["pause", "suspend", "limit", "signout"])
def test_policy_changes_during_upload_are_rechecked_after_streaming(
    clients, photo, monkeypatch, change
):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    scan_id = create(member, photo).json()["id"]
    original = storage.put

    def before_write(*args, **kwargs):
        if change == "signout":
            assert (
                admin.post(
                    f"/api/auth/accounts/{owner}/signout", json={"expected_version": 1}
                ).status_code
                == 200
            )
        else:
            field = {
                "pause": "scans_paused",
                "suspend": "suspended",
                "limit": "scan_card_limit_override",
            }[change]
            policy(admin, owner, **{field: 0 if change == "limit" else True})
        return original(*args, **kwargs)

    monkeypatch.setattr(storage, "put", before_write)
    result = member.put(
        f"/api/v1/scans/{scan_id}/upload", content=photo, headers={"Content-Type": "image/jpeg"}
    )
    assert result.status_code == (401 if change == "signout" else 403), result.text
    with session_factory()() as db:
        assert db.get(Scan, uuid.UUID(scan_id)).source_key is None
        assert db.get(User, owner).scan_cards_used == 0


def test_custom_member_limits_are_atomic_between_workers_and_use_current_limit(clients, photo):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member", scan_cards_used=137)
    scans = [upload(member, photo), upload(member, photo)]
    claims = [claim(uuid.UUID(accept(member, scan)["job_id"])) for scan in scans]
    policy(admin, owner, scan_card_limit_override=140)
    barrier = threading.Barrier(2)

    def complete(claimed):
        barrier.wait(timeout=5)
        return finish(claimed, image_result(3))

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(complete, claims)) == [False, True]
    assert all(finish(claimed, image_result(3)) is False for claimed in claims)
    assert member.get("/api/auth/me").json()["scan_cards_used"] == 140
    with session_factory()() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Observation)
                .where(Observation.scan_id.in_([uuid.UUID(s) for s in scans]))
            )
            == 3
        )
        failed = db.scalar(
            select(Job).where(Job.scan_id.in_([uuid.UUID(s) for s in scans]), Job.state == "FAILED")
        )
        assert failed.error_code == "SCAN_CARD_LIMIT"
    assert create(member, photo).status_code == 403


def test_paused_scan_review_and_imports_remain_available_without_refunds(clients, account_catalog):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    scan_id, job_id, rows = prepared(member)
    policy(admin, owner, scans_paused=True)
    with session_factory()() as db, db.begin():
        job = db.get(Job, uuid.UUID(job_id))
        job.state = "SUCCEEDED"
    path = f"/api/v1/scans/{scan_id}"
    assert (
        member.post(path + "/identify", json={"find_missing": True}, headers=key()).status_code
        == 403
    )
    assert (
        member.post(
            path + "/observations",
            json={"polygon": [[0.77, 0.65], [0.96, 0.65], [0.96, 0.98], [0.77, 0.98]]},
            headers=key(),
        ).status_code
        == 403
    )
    row = rows[0]
    adjusted = member.put(
        path + f"/observations/{row['id']}/geometry",
        json={
            "expected_version": row["version"],
            "polygon": [[x + 0.003, y] for x, y in row["polygon"]],
        },
        headers=key(),
    )
    assert adjusted.status_code == 200, adjusted.text
    rows = member.get(path + "/observations").json()["items"]
    assert approve(member, scan_id, rows, account_catalog[0]).status_code == 200
    commit(member, preview(member, [{"Scryfall ID": account_catalog[0], "Quantity": "200"}]))
    assert member.get("/api/auth/me").json()["collection_copies"] == 202
    assert deletion(member, scan_id).status_code == 200
    me = member.get("/api/auth/me").json()
    assert me["collection_copies"] == 200 and me["scan_cards_used"] == 2


def test_signout_suspend_restore_and_other_devices_preserve_current_account(clients, monkeypatch):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    provider(monkeypatch, owner)
    with extra_session(owner) as second:
        me = member.get("/api/auth/me").json()
        assert me["active_sessions"] == 2
        ended = member.post(
            "/api/auth/me/signout-others", json={"expected_version": me["account_version"]}
        )
        assert ended.json()["sessions_ended"] == 1
        assert second.get("/api/auth/session").status_code == 401
        assert member.get("/api/auth/session").status_code == 200
    detail = admin.get(f"/api/auth/accounts/{owner}").json()
    assert (
        admin.post(
            f"/api/auth/accounts/{owner}/signout",
            json={"expected_version": detail["account_version"]},
        ).json()["sessions_ended"]
        == 1
    )
    assert member.get("/api/auth/session").status_code == 401
    assert login(member).headers["location"] == "/"
    assert member.get("/api/auth/session").status_code == 200
    with extra_session(owner) as second:
        suspended = policy(admin, owner, suspended=True)
        assert suspended["active_sessions"] == 0
        assert member.get("/api/auth/session").status_code == 401
        assert second.get("/api/auth/session").status_code == 401
        assert login(member).headers["location"] == "/?account_suspended=1"
        policy(admin, owner, suspended=False)
        assert second.get("/api/auth/session").status_code == 401
    assert login(member).headers["location"] == "/"
    assert member.get("/api/auth/me").json()["suspended"] is False


def test_password_flow_requires_same_account_and_fresh_provider_login(clients, monkeypatch):
    member, owner = clients(role="member")
    _, other = clients(role="member")
    values = provider(monkeypatch, owner)
    original = values["subject"]
    assert login(member, "password").headers["location"] == "/?account=1"
    assert values["options"] == {"kc_action": "UPDATE_PASSWORD", "prompt": "login"}
    with session_factory()() as db, db.begin():
        user = db.get(User, other)
        user.issuer = get_settings().oidc_issuer
        values["subject"] = user.subject
    assert "login_account_changed" in login(member, "password").headers["location"]
    assert member.get("/api/auth/session").json()["owner_id"] == str(owner)
    values["subject"] = original
    with TestClient(app, base_url=get_settings().app_url) as visitor:
        assert visitor.get("/api/auth/password").status_code == 401


def test_search_includes_display_alias_and_escapes_wildcards(clients):
    admin, _ = clients(role="admin")
    member, owner = clients(role="member")
    member.patch("/api/auth/me", json={"expected_version": 1, "display_name": "Binder%keeper"})
    for query in ["binder", "%"]:
        listing = admin.get("/api/auth/accounts", params={"guests_only": False, "q": query}).json()
        assert [item["id"] for item in listing["items"]] == [str(owner)]
        assert listing["next_offset"] is None
    assert admin.get("/api/auth/accounts?q=binder").json()["items"] == []
