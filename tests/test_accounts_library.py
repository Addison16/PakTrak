import secrets
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import accept, create, upload
from fastapi import HTTPException
from sqlalchemy import delete, func, select
from starlette.responses import RedirectResponse
from test_collections import catalog as catalog
from test_collections import commit, export, key, preview, run_batch

from scanner import auth
from scanner.db import session_factory
from scanner.models import AccountPolicy, Deck, InventoryEvent, Observation, User
from scanner.settings import get_settings
from scanner.worker import claim, finish


@pytest.fixture(autouse=True)
def restore_policy(isolated_database):
    with session_factory()() as db:
        policy = db.get(AccountPolicy, 1)
        enabled, version = policy.guest_signup_enabled, policy.version
    yield
    with session_factory()() as db, db.begin():
        policy = db.get(AccountPolicy, 1)
        policy.guest_signup_enabled, policy.version = enabled, version
        db.execute(delete(User).where(User.subject.startswith("account-test-")))


def test_initial_setup_is_atomic_and_later_setups_are_guests():
    barrier = threading.Barrier(2)

    def enroll(_):
        with session_factory()() as db, db.begin():
            barrier.wait(timeout=5)
            user = auth.save_account(
                db, "account-test-" + secrets.token_hex(12), "New collector", initial_setup=True
            )
            return user.role

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(enroll, range(2))) == ["admin", "guest"]
    with session_factory()() as db, db.begin():
        assert not auth.setup_required(db)
        assert (
            auth.save_account(db, "account-test-late", "Late setup", initial_setup=True).role
            == "guest"
        )


def test_oidc_setup_intent_is_bound_to_its_verified_state(clients, monkeypatch):
    client, _ = clients()
    subject = "account-test-" + secrets.token_hex(12)

    class Provider:
        async def authorize_redirect(self, request, uri, state):
            return RedirectResponse("/test-provider?state=" + state)

        async def authorize_access_token(self, request, **kwargs):
            return {
                "userinfo": {
                    "iss": get_settings().oidc_issuer,
                    "sub": subject,
                    "preferred_username": "new-admin",
                    "role": "admin",
                }
            }

    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: Provider())
    first = client.get("/api/auth/setup", follow_redirects=False)
    state = first.headers["location"].split("state=")[1]
    result = client.get("/api/auth/callback?state=" + state, follow_redirects=False)
    assert result.status_code == 303
    assert client.get("/api/auth/session").json()["role"] == "admin"
    assert client.get("/api/auth/setup", follow_redirects=False).headers["location"] == "/"
    subject = "account-test-" + secrets.token_hex(12)
    regular = client.get("/api/auth/login", follow_redirects=False)
    state = regular.headers["location"].split("state=")[1]
    client.get("/api/auth/callback?state=" + state, follow_redirects=False)
    # A provider's role claim cannot make a normal signup an application admin.
    assert client.get("/api/auth/session").json()["role"] == "guest"


def test_admin_approval_is_authorized_and_applies_to_existing_sessions(clients, photo):
    admin, _ = clients(role="admin")
    guest, guest_id = clients(scan_cards_used=100)
    outsider, _ = clients()
    assert guest.get("/api/auth/accounts").status_code == 403
    assert guest.get("/api/auth/settings").status_code == 403
    assert outsider.post(f"/api/auth/accounts/{guest_id}/approve").status_code == 403
    assert create(guest, photo).status_code == 403
    assert (
        admin.post(
            f"/api/auth/accounts/{guest_id}/approve", headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )
    assert admin.post(f"/api/auth/accounts/{guest_id}/approve").json()["role"] == "member"
    assert admin.post(f"/api/auth/accounts/{guest_id}/approve").status_code == 200
    info = guest.get("/api/auth/session").json()
    assert info["role"] == "member" and info["scan_cards_remaining"] is None
    assert info["scan_cards_used"] == 100
    assert create(guest, photo).status_code == 201


def test_signup_toggle_blocks_direct_admission_but_keeps_existing_accounts(clients):
    admin, _ = clients(role="admin")
    guest, _ = clients()
    setting = admin.get("/api/auth/settings").json()
    body = {"expected_version": setting["version"], "guest_signup_enabled": False}
    assert guest.post("/api/auth/settings", json=body).status_code == 403
    saved = admin.post("/api/auth/settings", json=body)
    assert saved.status_code == 200
    assert admin.post("/api/auth/settings", json=body).status_code == 409
    assert guest.get("/api/auth/status").json()["guest_signup_enabled"] is False
    assert (
        guest.get("/api/auth/register", follow_redirects=False).headers["location"]
        == "/?registration_closed=1"
    )
    assert guest.get("/api/auth/session").status_code == 200
    with session_factory()() as db, pytest.raises(HTTPException, match="registration"):
        auth.save_account(db, "account-test-blocked", "Blocked", initial_setup=True)
    body["expected_version"] = saved.json()["version"]
    body["guest_signup_enabled"] = True
    assert admin.post("/api/auth/settings", json=body).status_code == 200
    with session_factory()() as db, db.begin():
        assert auth.save_account(db, "account-test-reopened", "Reopened").role == "guest"


def test_membership_welcome_waits_for_next_verified_login_and_dismisses_once(clients, monkeypatch):
    admin, _ = clients(role="admin")
    guest, user_id = clients(scan_cards_used=100)
    with session_factory()() as db, db.begin():
        user = db.get(User, user_id)
        user.issuer = get_settings().oidc_issuer
        subject = user.subject

    class Provider:
        async def authorize_redirect(self, request, uri, state):
            return RedirectResponse("/test-provider?state=" + state)

        async def authorize_access_token(self, request, **kwargs):
            return {
                "userinfo": {
                    "iss": get_settings().oidc_issuer,
                    "sub": subject,
                    "preferred_username": "Approved collector",
                }
            }

    monkeypatch.setattr(auth, "oidc_client", lambda **kwargs: Provider())
    assert guest.get("/api/auth/session").json()["membership_welcome"] is False
    assert admin.post(f"/api/auth/accounts/{user_id}/approve").status_code == 200
    assert guest.get("/api/auth/session").json()["membership_welcome"] is False
    assert guest.post("/api/auth/membership-welcome/dismiss").status_code == 403

    def login():
        first = guest.get("/api/auth/login", follow_redirects=False)
        state = first.headers["location"].split("state=")[1]
        assert (
            guest.get("/api/auth/callback?state=" + state, follow_redirects=False).status_code
            == 303
        )
        info = guest.get("/api/auth/session").json()
        guest.headers["X-CSRF-Token"] = info["csrf_token"]
        return info

    info = login()
    assert info["membership_welcome"] is True and info["role"] == "member"
    assert info["scan_cards_used"] == 100 and info["scan_card_limit"] is None
    assert (
        guest.post(
            "/api/auth/membership-welcome/dismiss", headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )
    assert guest.get("/api/auth/session").json()["membership_welcome"] is True
    assert guest.post("/api/auth/membership-welcome/dismiss").json()["membership_welcome"] is False
    assert guest.post("/api/auth/membership-welcome/dismiss").status_code == 200
    assert admin.post(f"/api/auth/accounts/{user_id}/approve").status_code == 200
    assert login()["membership_welcome"] is False


def image_result(regions=1):
    return {
        "width": 40,
        "height": 20,
        "prepared_key": "fixture-prepared",
        "thumbnail_key": "fixture-thumb",
        "regions": [
            {"polygon": [[0, 0], [1, 0], [1, 1], [0, 1]], "crop_key": f"fixture-crop-{index}"}
            for index in range(regions)
        ],
    }


def test_concurrent_scans_cannot_exceed_the_guest_card_allowance(clients, photo):
    client, owner_id = clients(scan_cards_used=97)
    scans = [upload(client, photo), upload(client, photo)]
    claims = [claim(uuid.UUID(accept(client, scan)["job_id"])) for scan in scans]
    barrier = threading.Barrier(2)

    def complete(claimed):
        barrier.wait(timeout=5)
        return finish(claimed, image_result(3))

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(complete, claims)) == [False, True]
    with session_factory()() as db:
        assert db.get(User, owner_id).scan_cards_used == 100
        assert (
            db.scalar(
                select(func.count())
                .select_from(Observation)
                .where(Observation.scan_id.in_([uuid.UUID(value) for value in scans]))
            )
            == 3
        )
    for claimed in claims:
        assert finish(claimed, image_result(3)) is False
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 100
    failed = [
        client.get("/api/v1/scans/" + scan).json()
        for scan in scans
        if client.get("/api/v1/scans/" + scan).json()["state"] == "FAILED"
    ][0]
    assert failed["job"]["error_code"] == "GUEST_SCAN_LIMIT"
    assert create(client, photo).status_code == 403


def test_guest_scan_limit_counts_cards_not_imports_or_retries(clients, photo, catalog):
    client, owner_id = clients(scan_cards_used=99)
    batch = commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "200"}]))
    assert client.get("/api/auth/session").json()["scan_cards_remaining"] == 1
    scan_id = upload(client, photo)
    claimed = claim(uuid.UUID(accept(client, scan_id)["job_id"]))
    assert not finish(claimed, image_result(2))
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 99
    scan_id = upload(client, photo)
    claimed = claim(uuid.UUID(accept(client, scan_id)["job_id"]))
    assert finish(claimed, image_result(1))
    assert not finish(claimed, image_result(1))
    undone = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        json={"expected_revision": batch["revision"]},
        headers=key(),
    ).json()
    run_batch(client, undone, "IMPORT_UNDO")
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 100
    with session_factory()() as db, db.begin():
        db.get(User, owner_id).role = "member"
    scan_id = upload(client, photo)
    assert finish(claim(uuid.UUID(accept(client, scan_id)["job_id"])), image_result(3))


def test_locations_search_moves_preserve_provenance_and_undo(clients, catalog):
    client, _ = clients()
    stranger, _ = clients()
    batch = commit(
        client,
        preview(
            client, [{"Scryfall ID": catalog[0], "Quantity": "3", "Binder Name": "Red binder"}]
        ),
    )
    box = client.post(
        "/api/v1/binders",
        json={"name": "Box 4", "kind": "box", "notes": "Top shelf"},
        headers=key(),
    ).json()
    assert client.post("/api/v1/binders", json={"name": "   "}, headers=key()).status_code == 422
    lot = client.get("/api/v1/collection?q=fixture").json()["items"][0]
    assert client.get("/api/v1/collection?q=%").json()["copies"] == 0
    move_key = key()
    move = {"binder_id": box["id"], "expected_version": lot["version"]}
    assert (
        stranger.post(f"/api/v1/collection/{lot['id']}/move", json=move, headers=key()).status_code
        == 404
    )
    assert (
        client.post(f"/api/v1/collection/{lot['id']}/move", json=move, headers=move_key).status_code
        == 200
    )
    assert (
        client.post(f"/api/v1/collection/{lot['id']}/move", json=move, headers=move_key).status_code
        == 200
    )
    assert client.get("/api/v1/collection?binder_id=" + box["id"]).json()["copies"] == 3
    location = next(
        item for item in client.get("/api/v1/binders").json()["items"] if item["id"] == box["id"]
    )
    assert location["copies"] == 3 and location["kind"] == "box"
    assert (
        client.post(
            "/api/v1/binders/" + box["id"],
            json={
                "name": "Blue box",
                "kind": "box",
                "notes": "Shelf 2",
                "expected_version": location["version"],
            },
            headers=key(),
        ).status_code
        == 200
    )
    assert client.get("/api/v1/collection").json()["items"][0]["binder"] == "Blue box"
    undone = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        json={"expected_revision": batch["revision"]},
        headers=key(),
    ).json()
    run_batch(client, undone, "IMPORT_UNDO")
    assert client.get("/api/v1/collection").json()["copies"] == 0
    with session_factory()() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(InventoryEvent)
                .where(InventoryEvent.lot_id == uuid.UUID(lot["id"]), InventoryEvent.kind == "MOVE")
            )
            == 1
        )


def test_decks_save_owned_cards_show_locations_and_report_later_shortages(clients, catalog):
    client, _ = clients()
    stranger, _ = clients()
    commit(
        client,
        preview(
            client, [{"Scryfall ID": catalog[0], "Quantity": "3", "Binder Name": "Red binder"}]
        ),
    )
    create_key = key()
    deck = client.post("/api/v1/decks", json={"name": "Friday night"}, headers=create_key).json()
    assert (
        client.post("/api/v1/decks", json={"name": "Friday night"}, headers=create_key).json()["id"]
        == deck["id"]
    )
    assert (
        client.post("/api/v1/decks", json={"name": "Other"}, headers=create_key).status_code == 409
    )
    assert stranger.get("/api/v1/decks/" + deck["id"]).status_code == 404
    body = {
        "name": "Friday night",
        "format": "commander",
        "notes": "Keep sleeves blue",
        "expected_version": deck["version"],
        "cards": [
            {"printing_id": catalog[0], "section": "main", "quantity": 2},
            {"printing_id": catalog[0], "section": "sideboard", "quantity": 1},
        ],
    }
    edit_key = key()
    saved = client.post("/api/v1/decks/" + deck["id"], json=body, headers=edit_key)
    assert saved.status_code == 200, saved.text
    assert (
        client.post("/api/v1/decks/" + deck["id"], json=body, headers=edit_key).status_code == 200
    )
    assert client.post("/api/v1/decks/" + deck["id"], json=body, headers=key()).status_code == 409
    saved = saved.json()
    assert saved["copies"] == 3 and saved["missing_copies"] == 0
    assert saved["cards"][0]["locations"][0]["name"] == "Red binder"
    body["expected_version"] = saved["version"]
    body["cards"][0]["quantity"] = 3
    planned = client.post("/api/v1/decks/" + deck["id"], json=body, headers=key())
    assert planned.status_code == 200 and planned.json()["missing_copies"] == 1
    assert client.get("/api/v1/collection").json()["copies"] == 3
    text = client.get(f"/api/v1/decks/{deck['id']}/download?format=text")
    assert "Mainboard\n3 Synthetic Fixture Card (TST) 1" in text.text
    assert "Sideboard\n1 Synthetic Fixture Card (TST) 1" in text.text
    assert stranger.get(f"/api/v1/decks/{deck['id']}/download").status_code == 404
    lot = client.get("/api/v1/collection").json()["items"][0]
    assert (
        client.post(
            f"/api/v1/collection/{lot['id']}/quantity",
            json={"quantity": 1, "expected_version": lot["version"]},
            headers=key(),
        ).status_code
        == 200
    )
    refreshed = client.get("/api/v1/decks/" + deck["id"]).json()
    assert refreshed["missing_copies"] == 3
    assert refreshed["cards"][0]["locations"][0]["quantity"] == 1
    assert (
        client.post(
            f"/api/v1/decks/{deck['id']}/archive",
            json={"expected_version": refreshed["version"]},
            headers=key(),
        ).status_code
        == 200
    )
    assert client.get("/api/v1/decks").json()["items"] == []
    assert client.get("/api/v1/collection").json()["copies"] == 1
    with session_factory()() as db:
        assert db.get(Deck, uuid.UUID(deck["id"])).archived


def test_deck_planning_never_counts_another_collectors_cards(clients, catalog):
    owner, _ = clients()
    stranger, _ = clients()
    commit(owner, preview(owner, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    deck = stranger.post("/api/v1/decks", json={"name": "No holdings"}, headers=key()).json()
    response = stranger.post(
        "/api/v1/decks/" + deck["id"],
        json={
            "name": "No holdings",
            "expected_version": 1,
            "cards": [{"printing_id": catalog[0], "quantity": 1}],
        },
        headers=key(),
    )
    assert response.status_code == 200
    assert response.json()["owned_copies"] == 0 and response.json()["missing_copies"] == 1
    assert response.json()["cards"][0]["locations"] == []
    assert stranger.get("/api/v1/collection").json()["copies"] == 0
    assert owner.get("/api/v1/collection").json()["copies"] == 2


def test_text_lists_preview_confirm_and_roundtrip_without_inventing_printings(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    data = b"# My cards\nMainboard\n2x Synthetic Fixture Card (TST) 1 *F*\nSideboard\n1 Synthetic Fixture Card (TST) 2\nSynthetic Fixture Card\n"
    batch = preview(client, data=data, filename="collection.txt")
    assert batch["format"] == "text"
    assert batch["options"]["text_default_finish"] == "nonfoil"
    assert batch["summary"]["ready_copies"] == 3
    assert batch["summary"]["unresolved_rows"] == 1
    assert client.get("/api/v1/collection").json()["copies"] == 0
    commit(client, batch, accept_partial=True)
    assert {item["finish"] for item in client.get("/api/v1/collection").json()["items"]} == {
        "nonfoil",
        "foil",
    }
    saved = export(client, "text")
    output = client.get(saved["download_url"])
    assert output.headers["content-type"].startswith("text/plain")
    assert ".txt" in output.headers["content-disposition"]
    assert "2 Synthetic Fixture Card (TST) 1 *F*" in output.text
    assert saved["report"]["excluded_copies"] == 0
    restored = preview(other, data=output.content, filename="restored.txt")
    assert restored["summary"]["ready_copies"] == 3
    commit(other, restored)
    assert other.get("/api/v1/collection").json()["copies"] == 3


def test_text_unmarked_finish_option_preserves_foil_and_etched_markers(clients, catalog):
    client, _ = clients()
    batch = preview(
        client,
        data=b"4 Synthetic Fixture Card (TST) 1\n2 Synthetic Fixture Card (TST) 1 *F*\n3 Synthetic Fixture Card (TST) 1 *E*\n",
        filename="finishes.txt",
    )
    path = "/api/v1/imports/" + batch["id"]
    rows = client.get(path + "/rows").json()["items"]
    assert [(row["normalized"]["finish"], row["normalized"]["quantity"]) for row in rows] == [
        ("nonfoil", 4),
        ("foil", 2),
        ("etched", 3),
    ]
    response = client.post(
        path + "/preview",
        headers=key(),
        json={
            "expected_revision": batch["revision"],
            "mapping": batch["mapping"],
            "options": {"text_default_finish": "unknown"},
        },
    )
    assert response.status_code == 202
    run_batch(client, response.json(), "IMPORT_PREVIEW")
    rows = client.get(path + "/rows").json()["items"]
    assert [(row["normalized"]["finish"], row["normalized"]["quantity"]) for row in rows] == [
        ("unknown", 4),
        ("foil", 2),
        ("etched", 3),
    ]
    batch = client.get(path).json()
    assert batch["options"]["text_default_finish"] == "unknown"
    commit(client, batch)
    assert {item["finish"] for item in client.get("/api/v1/collection").json()["items"]} == {
        "unknown",
        "foil",
        "etched",
    }


def test_portable_csv_can_be_imported_with_locations_and_unknowns(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "4",
                    "Location": "Box 4",
                    "Notes": "Test note",
                }
            ],
        ),
    )
    saved = export(client, "csv")
    restored = preview(other, data=client.get(saved["download_url"]).content)
    commit(other, restored)
    lot = other.get("/api/v1/collection").json()["items"][0]
    assert (lot["quantity"], lot["binder"], lot["finish"], lot["condition"], lot["notes"]) == (
        4,
        "Box 4",
        "unknown",
        "ungraded",
        "Test note",
    )
