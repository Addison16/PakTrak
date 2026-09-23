import secrets
import uuid

import pytest
from conftest import create
from sqlalchemy import select
from test_collections import catalog as catalog
from test_collections import geometry_photo, key
from test_scan_batches import approve, deletion, prepared, result

from scanner import recognition
from scanner.db import session_factory
from scanner.models import Deck, DeckScanCard, InventoryLot, Job, Observation, Scan, User, now
from scanner.worker import process_job


def deck(client, name="My photographed deck"):
    response = client.post(
        "/api/v1/decks", headers=key(), json={"name": name, "format": "commander"}
    )
    assert response.status_code == 201, response.text
    return response.json()


def saved_batch(client, owner, target, printing_ids, collection=False):
    with session_factory()() as db, db.begin():
        scan = Scan(
            owner_id=owner,
            request_key=secrets.token_hex(16),
            request_hash="a" * 64,
            filename="deck-photo.jpg",
            mime_type="image/jpeg",
            expected_bytes=100,
            foil_count=0,
            add_to_collection=collection,
            target_deck_id=uuid.UUID(target["id"]),
            state="PHOTO_READY",
            accepted_at=now(),
        )
        db.add(scan)
        db.flush()
        rows = []
        for index in range(len(printing_ids)):
            row = Observation(
                id=uuid.uuid4(),
                scan_id=scan.id,
                region_index=index,
                polygon=[[0, 0], [1, 0], [1, 1], [0, 1]],
                detector_version="deck-test",
                finish="nonfoil",
                recognition={"status": "unmatched"},
            )
            db.add(row)
            rows.append({"id": str(row.id), "version": 1})
        scan_id = str(scan.id)
    for row, printing in zip(rows, printing_ids, strict=True):
        if printing:
            response = approve(client, scan_id, [row], printing)
            assert response.status_code == 200, response.text
    return scan_id


def preview(client, target, scans):
    response = client.post(
        "/api/v1/deck-scans/preview",
        headers=key(),
        json={"deck_id": target["id"], "scan_ids": scans},
    )
    assert response.status_code == 200, response.text
    return response.json()


def save_body(target, scans, value):
    return {
        "deck_id": target["id"],
        "scan_ids": scans,
        "expected_version": value["deck_version"],
        "token": value["token"],
        "items": [
            {"observation_id": item["observation_id"], "section": "main"} for item in value["items"]
        ],
    }


def test_deck_scan_defaults_bind_to_owned_decks_and_keep_legacy_upload_receipts(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    target = deck(client)
    photo = geometry_photo()
    normal = create(client, photo, key="legacy-deck-scan-upload")
    assert normal.status_code == 201
    assert normal.json()["add_to_collection"] is True
    assert create(client, photo, key="legacy-deck-scan-upload").status_code == 200
    value = create(client, photo, target_deck_id=target["id"])
    assert value.status_code == 201, value.text
    assert value.json()["add_to_collection"] is False
    assert value.json()["target_deck"]["name"] == target["name"]
    assert (
        create(client, photo, target_deck_id=target["id"], add_to_collection=True).json()[
            "add_to_collection"
        ]
        is True
    )
    assert create(other, photo, target_deck_id=target["id"]).status_code == 404
    assert create(client, photo, add_to_collection=False).status_code == 422
    with session_factory()() as db, db.begin():
        db.get(Deck, uuid.UUID(target["id"])).archived = True
    assert create(client, photo, target_deck_id=target["id"]).status_code == 404


@pytest.mark.parametrize("strength,confirmed", [(0.88, False), (0.89, True)])
def test_deck_scan_processing_confirms_without_inventory_and_charges_each_card_once(
    clients, catalog, monkeypatch, strength, confirmed
):
    client, owner = clients()
    target = deck(client)
    suggestion = result(catalog[0])
    suggestion["candidates"][0]["match_score"] = strength
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: suggestion)
    scan_id, job_id, _ = prepared(client, target_deck_id=target["id"])
    for _ in range(4):
        process_job(job_id)
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert data["add_to_collection"] is False
    assert data["summary"]["confirmed"] == (2 if confirmed else 0)
    assert all(row["lot"] is None for row in data["items"])
    assert all((row["confirmed_printing"] is not None) == confirmed for row in data["items"])
    assert client.get("/api/v1/collection").json()["copies"] == 0
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 2
        assert db.get(Job, uuid.UUID(job_id)).result["cards_added"] == 0
        assert db.get(Job, uuid.UUID(job_id)).state == "SUCCEEDED"
    if not confirmed:
        assert approve(client, scan_id, data["items"], catalog[0]).status_code == 200
    value = preview(client, target, [scan_id])
    assert len(value["items"]) == 2
    response = client.post(
        "/api/v1/deck-scans/save", headers=key(), json=save_body(target, [scan_id], value)
    )
    assert response.status_code == 200, response.text
    assert response.json()["copies"] == 2
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 2
    assert client.get("/api/v1/collection").json()["copies"] == 0


def test_multiple_batches_combine_copies_preserve_sections_and_retry_without_duplicate_sources(
    clients, catalog
):
    client, owner = clients()
    target = deck(client)
    first = saved_batch(client, owner, target, [catalog[0], catalog[0]])
    second = saved_batch(client, owner, target, [catalog[0], catalog[1]])
    scans = [first, second]
    value = preview(client, target, scans)
    body = save_body(target, scans, value)
    body["items"][0]["section"] = "commander"
    body["items"][-1]["section"] = "sideboard"
    receipt = key()
    saved = client.post("/api/v1/deck-scans/save", headers=receipt, json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["copies"] == 4
    assert sorted(card["quantity"] for card in saved.json()["cards"]) == [1, 1, 2]
    assert client.post("/api/v1/deck-scans/save", headers=receipt, json=body).json()["copies"] == 4
    assert client.post("/api/v1/deck-scans/save", headers=key(), json=body).status_code == 409
    changed = {**body, "items": body["items"][:1]}
    assert client.post("/api/v1/deck-scans/save", headers=receipt, json=changed).status_code == 409
    after = preview(client, target, scans)
    assert after["items"] == []
    assert sum(batch["already_added"] for batch in after["batches"]) == 4
    listed = client.get(f"/api/v1/deck-scans/batches?deck_id={target['id']}").json()
    assert len(listed["items"]) == 2
    assert sum(batch["already_added"] for batch in listed["items"]) == 4
    assert client.get("/api/v1/collection").json()["copies"] == 0
    # A later deck edit cannot turn a lost-response retry into another addition.
    with session_factory()() as db, db.begin():
        db.get(Deck, uuid.UUID(target["id"])).version += 1
    assert client.post("/api/v1/deck-scans/save", headers=receipt, json=body).json()["copies"] == 4


def test_pending_matches_can_be_added_later_and_existing_collection_scans_are_not_copied_again(
    clients, catalog
):
    client, owner = clients()
    target = deck(client)
    scan_id = saved_batch(client, owner, target, [catalog[0], None], collection=True)
    assert client.get("/api/v1/collection").json()["copies"] == 1
    value = preview(client, target, [scan_id])
    assert value["batches"][0]["pending"] == 1
    assert len(value["items"]) == 1
    first = client.post(
        "/api/v1/deck-scans/save", headers=key(), json=save_body(target, [scan_id], value)
    )
    assert first.status_code == 200, first.text
    rows = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert (
        approve(
            client, scan_id, [row for row in rows if row["state"] == "NEEDS_REVIEW"], catalog[0]
        ).status_code
        == 200
    )
    value = preview(client, target, [scan_id])
    assert value["batches"][0]["already_added"] == 1
    assert len(value["items"]) == 1
    second = client.post(
        "/api/v1/deck-scans/save", headers=key(), json=save_body(target, [scan_id], value)
    )
    assert second.json()["copies"] == 2
    assert second.json()["cards"][0]["quantity"] == 2
    assert client.get("/api/v1/collection").json()["copies"] == 2
    assert deletion(client, scan_id).status_code == 200
    assert client.get(f"/api/v1/decks/{target['id']}").json()["copies"] == 2
    assert client.get("/api/v1/collection").json()["copies"] == 0


def test_deck_only_corrections_finishes_and_alternate_approval_route_never_create_lots(
    clients, catalog
):
    client, owner = clients()
    target = deck(client)
    scan_id = saved_batch(client, owner, target, [catalog[0], None])
    rows = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert approve(client, scan_id, rows[:1], catalog[1], finish="foil").status_code == 200
    response = client.post(
        f"/api/v1/scans/{scan_id}/observations/{rows[1]['id']}/decision",
        headers=key(),
        json={
            "expected_version": rows[1]["version"],
            "action": "add",
            "printing_id": catalog[1],
            "finish": "nonfoil",
        },
    )
    assert response.status_code == 200, response.text
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert all(row["confirmed_printing"]["id"] == catalog[1] for row in data["items"])
    finish = client.post(
        f"/api/v1/scans/{scan_id}/finishes",
        headers=key(),
        json={"foil_count": 1, "foil_ids": [rows[0]["id"]], "token": data["finishes"]["token"]},
    )
    assert finish.status_code == 200, finish.text
    current = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    ignored = client.post(
        f"/api/v1/scans/{scan_id}/observations/{current['id']}/decision",
        headers=key(),
        json={"expected_version": current["version"], "action": "ignore"},
    )
    assert ignored.status_code == 200
    assert len(preview(client, target, [scan_id])["items"]) == 1
    assert client.get("/api/v1/collection").json()["copies"] == 0
    with session_factory()() as db:
        assert list(db.scalars(select(InventoryLot).where(InventoryLot.owner_id == owner))) == []


def test_deck_preview_rejects_other_owners_stale_corrections_and_deletions(clients, catalog):
    client, owner = clients()
    other, other_owner = clients()
    target, other_deck = deck(client), deck(other)
    scan_id = saved_batch(client, owner, target, [catalog[0]])
    foreign = saved_batch(other, other_owner, other_deck, [catalog[0]])
    assert (
        client.post(
            "/api/v1/deck-scans/preview",
            headers=key(),
            json={"deck_id": target["id"], "scan_ids": [foreign]},
        ).status_code
        == 404
    )
    assert other.get(f"/api/v1/deck-scans/batches?deck_id={target['id']}").status_code == 404
    value = preview(client, target, [scan_id])
    body = save_body(target, [scan_id], value)
    row = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    assert approve(client, scan_id, [row], catalog[1]).status_code == 200
    assert client.post("/api/v1/deck-scans/save", headers=key(), json=body).status_code == 409
    value = preview(client, target, [scan_id])
    body = save_body(target, [scan_id], value)
    assert deletion(client, scan_id).status_code == 200
    assert client.post("/api/v1/deck-scans/save", headers=key(), json=body).status_code == 404
    assert client.get(f"/api/v1/decks/{target['id']}").json()["copies"] == 0
    with session_factory()() as db:
        assert (
            list(
                db.scalars(
                    select(DeckScanCard).where(DeckScanCard.deck_id == uuid.UUID(target["id"]))
                )
            )
            == []
        )


@pytest.mark.parametrize("policy", ["guest_limit", "custom_limit", "paused"])
def test_deck_only_uploads_cannot_bypass_scan_allowances(clients, policy):
    client, owner = clients(
        role="guest" if policy == "guest_limit" else "member", scan_cards_used=100
    )
    target = deck(client)
    with session_factory()() as db, db.begin():
        user = db.get(User, owner)
        if policy == "custom_limit":
            user.scan_card_limit_override = 100
        if policy == "paused":
            user.scans_paused = True
    response = create(
        client, geometry_photo(), target_deck_id=target["id"], add_to_collection=False
    )
    assert response.status_code == 403, response.text
    assert client.get(f"/api/v1/decks/{target['id']}").status_code == 200


def test_opt_in_scan_adds_collection_once_and_adding_to_deck_does_not_add_again(
    clients, catalog, monkeypatch
):
    client, _ = clients()
    target = deck(client)
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: result(catalog[0]))
    scan_id, job_id, _ = prepared(client, target_deck_id=target["id"], add_to_collection=True)
    for _ in range(4):
        process_job(job_id)
    assert client.get("/api/v1/collection").json()["copies"] == 2
    value = preview(client, target, [scan_id])
    response = client.post(
        "/api/v1/deck-scans/save", headers=key(), json=save_body(target, [scan_id], value)
    )
    assert response.status_code == 200, response.text
    assert response.json()["copies"] == 2
    assert client.get("/api/v1/collection").json()["copies"] == 2
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 2


def test_bad_or_pending_source_and_duplicate_source_reject_the_whole_save(clients, catalog):
    client, owner = clients()
    target = deck(client)
    scan_id = saved_batch(client, owner, target, [catalog[0], None])
    value = preview(client, target, [scan_id])
    good = save_body(target, [scan_id], value)
    pending = next(
        row
        for row in client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
        if row["state"] == "NEEDS_REVIEW"
    )
    for item, status in [
        (good["items"][0], 422),
        ({"observation_id": pending["id"], "section": "main"}, 409),
        ({"observation_id": str(uuid.uuid4()), "section": "main"}, 409),
    ]:
        bad = {**good, "items": [*good["items"], item]}
        response = client.post("/api/v1/deck-scans/save", headers=key(), json=bad)
        assert response.status_code == status, response.text
        assert client.get(f"/api/v1/decks/{target['id']}").json()["copies"] == 0
    assert (
        client.post(
            "/api/v1/deck-scans/preview",
            headers=key(),
            json={"deck_id": target["id"], "scan_ids": [scan_id, scan_id]},
        ).status_code
        == 422
    )
    assert len(preview(client, target, [scan_id])["items"]) == 1


def test_concurrent_saves_with_different_keys_add_a_photo_card_only_once(clients, catalog):
    from concurrent.futures import ThreadPoolExecutor

    from test_account_management import extra_session

    client, owner = clients()
    target = deck(client)
    scan_id = saved_batch(client, owner, target, [catalog[0], catalog[0]])
    body = save_body(target, [scan_id], preview(client, target, [scan_id]))

    def save_once(_):
        with extra_session(owner) as other:
            return other.post("/api/v1/deck-scans/save", headers=key(), json=body).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(save_once, range(2)))
    assert sorted(outcomes) == [200, 409]
    assert client.get(f"/api/v1/decks/{target['id']}").json()["copies"] == 2
    assert client.get("/api/v1/collection").json()["copies"] == 0
