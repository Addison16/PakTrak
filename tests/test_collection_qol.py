"""Regression coverage for collection editing and source-preserving bulk actions."""

import uuid
from decimal import Decimal

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from test_collections import catalog as catalog
from test_collections import commit, key, preview, run_batch

from scanner.collection_api import fingerprint
from scanner.db import session_factory
from scanner.models import Binder, InventoryEvent, InventoryLot, Observation, Printing, Scan


def location(client, name):
    response = client.post("/api/v1/binders", headers=key(), json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_partial_moves_preserve_metadata_replay_safely_and_undo_all_descendants(clients, catalog):
    client, owner = clients()
    batch = commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "7",
                    "Binder Name": "Original binder",
                    "Finish": "foil",
                    "Condition": "LP",
                    "Notes": "Signed by a friend",
                    "Purchase Price": "1.2300",
                    "Purchase Price Currency": "usd",
                    "Extra source detail": "Keep this provenance",
                }
            ],
        ),
    )
    original = client.get("/api/v1/collection").json()["items"][0]
    destination = location(client, "Deck box")
    path = f"/api/v1/collection/{original['id']}/move"
    body = {"binder_id": destination, "expected_version": original["version"], "quantity": 3}
    receipt = key()
    response = client.post(path, headers=receipt, json=body)
    assert response.status_code == 200, response.text
    moved = response.json()
    assert moved["quantity_moved"] == 3 and moved["quantity"] == 4
    assert moved["moved_lot_id"] != original["id"]
    assert client.post(path, headers=receipt, json=body).json() == moved
    assert client.post(path, headers=receipt, json={**body, "quantity": 2}).status_code == 409
    assert client.post(path, headers=key(), json=body).status_code == 409
    with session_factory()() as db:
        parent = db.get(InventoryLot, uuid.UUID(original["id"]))
        child = db.get(InventoryLot, uuid.UUID(moved["moved_lot_id"]))
        assert child.owner_id == owner and child.split_parent_id == parent.id
        assert child.source_import_row_id == parent.source_import_row_id
        for attribute in (
            "printing_id",
            "finish",
            "condition",
            "notes",
            "source_metadata",
            "created_at",
        ):
            assert getattr(child, attribute) == getattr(parent, attribute)
        assert child.purchase_price == Decimal("1.2300") and child.purchase_currency == "USD"
        events = db.scalars(
            select(InventoryEvent).where(InventoryEvent.operation_key.like("move:%"))
        ).all()
        assert sum(event.delta for event in events if event.lot_id in {parent.id, child.id}) == 0
        child_version = child.version
    another = location(client, "Trade binder")
    response = client.post(
        f"/api/v1/collection/{moved['moved_lot_id']}/move",
        headers=key(),
        json={"binder_id": another, "expected_version": child_version, "quantity": 1},
    )
    assert response.status_code == 200, response.text
    with session_factory()() as db:
        grandchild = db.get(InventoryLot, uuid.UUID(response.json()["moved_lot_id"]))
        assert str(grandchild.split_parent_id) == original["id"]
    with pytest.raises(RuntimeError, match="Collection splits exist"):
        command.downgrade(Config("alembic.ini"), "f92c48d1a607")
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    assert client.get("/api/v1/collection").json()["copies"] == 9
    undo = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        headers=key(),
        json={"expected_revision": batch["revision"]},
    )
    assert undo.status_code == 202, undo.text
    assert client.post(path, headers=receipt, json=body).status_code == 409
    undone = run_batch(client, undo.json(), "IMPORT_UNDO")
    assert undone["state"] == "UNDONE" and undone["summary"]["undone_copies"] == 7
    assert client.get("/api/v1/collection").json()["copies"] == 2


def test_move_checks_available_quantity_and_location_ownership(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    lot = client.get("/api/v1/collection").json()["items"][0]
    own_bin, foreign_bin = location(client, "Own box"), location(other, "Other box")
    body = {"expected_version": lot["version"], "quantity": 1, "binder_id": own_bin}
    path = f"/api/v1/collection/{lot['id']}/move"
    assert other.post(path, headers=key(), json=body).status_code == 404
    assert (
        client.post(path, headers=key(), json={**body, "binder_id": foreign_bin}).status_code == 404
    )
    assert client.post(path, headers=key(), json={**body, "quantity": 3}).status_code == 409
    assert client.post(path, headers=key(), json={**body, "quantity": 0}).status_code == 422
    assert client.get("/api/v1/collection").json()["copies"] == 2


def test_bulk_move_is_explicit_atomic_idempotent_and_source_scoped(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    batch = commit(
        client,
        preview(
            client,
            [
                {"Scryfall ID": catalog[0], "Quantity": "3", "Binder Name": "Red binder"},
                {"Scryfall ID": catalog[0], "Quantity": "2", "Binder Name": "Blue binder"},
                {"Scryfall ID": catalog[1], "Quantity": "4", "Binder Name": "Red binder"},
            ],
        ),
    )
    bins = {item["name"]: item["id"] for item in client.get("/api/v1/binders").json()["items"]}
    destination = location(client, "Deck box")
    body = {
        "printing_ids": catalog,
        "source_binder_id": bins["Red binder"],
        "action": "move",
        "binder_id": destination,
    }
    preview_response = client.post("/api/v1/collection/bulk/preview", json=body)
    assert preview_response.status_code == 200, preview_response.text
    plan = preview_response.json()
    assert plan["copies"] == 7 and plan["groups_changed"] == 2
    assert {row["binder"] for row in plan["groups"]} == {"Red binder"}
    apply_body, receipt = {**body, "token": plan["token"]}, key()
    response = client.post("/api/v1/collection/bulk/apply", json=apply_body, headers=receipt)
    assert response.status_code == 200, response.text
    assert response.json() == {"copies_changed": 7, "groups": 2}
    assert (
        client.post("/api/v1/collection/bulk/apply", json=apply_body, headers=receipt).json()
        == response.json()
    )
    assert (
        client.post(
            "/api/v1/collection/bulk/apply",
            json={**apply_body, "printing_ids": [catalog[0]]},
            headers=receipt,
        ).status_code
        == 409
    )
    assert other.post("/api/v1/collection/bulk/preview", json=body).status_code == 404
    current = {
        item["name"]: item["copies"] for item in client.get("/api/v1/binders").json()["items"]
    }
    assert current["Deck box"] == 7 and current["Blue binder"] == 2 and current["Red binder"] == 0
    undo = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        headers=key(),
        json={"expected_revision": batch["revision"]},
    )
    assert undo.status_code == 202, undo.text
    run_batch(client, undo.json(), "IMPORT_UNDO")
    assert client.get("/api/v1/collection").json()["copies"] == 0


def test_bulk_stale_preview_fails_without_partial_changes_and_finish_replays(clients, catalog):
    client, _ = clients()
    commit(
        client,
        preview(
            client,
            [{"Scryfall ID": card, "Quantity": "2", "Finish": "nonfoil"} for card in catalog],
        ),
    )
    body = {"printing_ids": catalog, "action": "finish", "finish": "foil"}
    plan = client.post("/api/v1/collection/bulk/preview", json=body).json()
    lot = client.get("/api/v1/collection").json()["items"][0]
    edit = client.post(
        f"/api/v1/collection/{lot['id']}/quantity",
        headers=key(),
        json={"expected_version": lot["version"], "quantity": 1},
    )
    assert edit.status_code == 200, edit.text
    response = client.post(
        "/api/v1/collection/bulk/apply", headers=key(), json={**body, "token": plan["token"]}
    )
    assert response.status_code == 409, response.text
    assert {row["finish"] for row in client.get("/api/v1/collection").json()["items"]} == {
        "nonfoil"
    }
    next_plan = client.post("/api/v1/collection/bulk/preview", json=body).json()
    assert next_plan["copies"] == 3
    receipt, apply_body = key(), {**body, "token": next_plan["token"]}
    response = client.post("/api/v1/collection/bulk/apply", headers=receipt, json=apply_body)
    assert response.status_code == 200, response.text
    assert response.json()["copies_changed"] == 3
    assert (
        client.post("/api/v1/collection/bulk/apply", headers=receipt, json=apply_body).json()
        == response.json()
    )
    assert {row["finish"] for row in client.get("/api/v1/collection").json()["items"]} == {"foil"}
    assert (
        client.post(
            "/api/v1/collection/bulk/preview",
            json={**body, "printing_ids": [catalog[0], catalog[0]]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/collection/bulk/preview", json={**body, "printing_ids": [str(uuid.uuid4())]}
        ).status_code
        == 409
    )


def test_deep_collection_card_is_independent_of_filters_and_private(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[1], "Quantity": "3"}]))
    assert (
        client.get("/api/v1/collection/cards", params={"q": "No card matches"}).json()["items"]
        == []
    )
    response = client.get(f"/api/v1/collection/cards/{catalog[1]}")
    assert response.status_code == 200, response.text
    assert response.json()["printing"]["id"] == catalog[1] and response.json()["quantity"] == 3
    assert other.get(f"/api/v1/collection/cards/{catalog[1]}").status_code == 404
    assert client.get(f"/api/v1/collection/cards/{catalog[0]}").status_code == 404


def test_bulk_finish_validates_every_selected_printing_before_changing_any(clients, catalog):
    client, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": card, "Quantity": "2"} for card in catalog]))
    with session_factory()() as db, db.begin():
        card = db.get(Printing, uuid.UUID(catalog[1]))
        original_finishes = list(card.finishes)
        card.finishes = ["etched"]
    try:
        body = {"printing_ids": catalog, "action": "finish", "finish": "foil"}
        response = client.post("/api/v1/collection/bulk/preview", json=body)
        assert response.status_code == 422 and "unavailable" in response.text
        response = client.post(
            "/api/v1/collection/bulk/apply", headers=key(), json={**body, "token": "0" * 64}
        )
        assert response.status_code == 422, response.text
        assert {row["finish"] for row in client.get("/api/v1/collection").json()["items"]} == {
            "unknown"
        }
    finally:
        with session_factory()() as db, db.begin():
            db.get(Printing, uuid.UUID(catalog[1])).finishes = original_finishes


def test_attention_rows_skip_ready_rows_and_expose_previous_next(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    batch = preview(
        client,
        [
            {"Scryfall ID": catalog[0], "Quantity": "2"},
            {"Scryfall ID": str(uuid.uuid4()), "Quantity": "1"},
            {"Scryfall ID": catalog[1], "Quantity": "2"},
            {"Scryfall ID": catalog[1], "Quantity": "invalid"},
        ],
    )
    path = f"/api/v1/imports/{batch['id']}/rows"
    response = client.get(path, params={"attention": True})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["attention_count"] == 2
    assert [row["state"] for row in result["items"]] == ["UNRESOLVED", "INVALID"]
    first, second = [row["row_number"] for row in result["items"]]
    focused = client.get(path, params={"focus": first}).json()
    assert (
        len(focused["items"]) == 1
        and focused["previous_issue"] is None
        and focused["next_issue"] == second
    )
    focused = client.get(path, params={"focus": second}).json()
    assert (
        len(focused["items"]) == 1
        and focused["previous_issue"] == first
        and focused["next_issue"] is None
    )
    assert other.get(path, params={"attention": True}).status_code == 404


def test_attention_navigation_does_not_skip_the_first_issue_on_the_next_page(clients, catalog):
    client, _ = clients()
    batch = preview(
        client, [{"Scryfall ID": str(uuid.uuid4()), "Quantity": "1"} for _ in range(45)]
    )
    path = f"/api/v1/imports/{batch['id']}/rows"
    first = client.get(path, params={"attention": True}).json()
    assert len(first["items"]) == 40 and first["attention_count"] == 45
    second = client.get(path, params={"attention": True, "offset": first["next_offset"]}).json()
    assert len(second["items"]) == 5
    assert first["next_issue"] == second["items"][0]["row_number"]
    assert second["previous_issue"] == first["items"][-1]["row_number"]


def test_scanned_physical_regions_cannot_split_and_bulk_finishes_sync_observations(
    clients, catalog
):
    client, owner = clients()
    destination = location(client, "Another binder")
    with session_factory()() as db, db.begin():
        binder = Binder(owner_id=owner, name="Photo binder")
        scan = Scan(
            owner_id=owner,
            request_key=str(uuid.uuid4()),
            request_hash="a" * 64,
            filename="fixture.jpg",
            mime_type="image/jpeg",
            expected_bytes=1,
            state="PHOTO_READY",
        )
        db.add_all([binder, scan])
        db.flush()
        observation = Observation(
            id=uuid.uuid4(),
            scan_id=scan.id,
            region_index=0,
            polygon=[[0, 0], [1, 0], [1, 1], [0, 1]],
            detector_version="fixture",
            finish="nonfoil",
            state="ADDED",
        )
        db.add(observation)
        db.flush()
        # The deliberately malformed quantity checks the defensive API guard.
        lot = InventoryLot(
            owner_id=owner,
            binder_id=binder.id,
            printing_id=uuid.UUID(catalog[0]),
            source_observation_id=observation.id,
            quantity_remaining=2,
            finish="nonfoil",
        )
        db.add(lot)
        db.flush()
        lot_id, observation_id, binder_id = str(lot.id), observation.id, binder.id
    response = client.post(
        f"/api/v1/collection/{lot_id}/move",
        headers=key(),
        json={"binder_id": destination, "expected_version": 1, "quantity": 1},
    )
    assert response.status_code == 422 and "cannot be split" in response.text
    with pytest.raises(IntegrityError, match="lot_scan_cannot_split"):
        with session_factory()() as db, db.begin():
            db.add(
                InventoryLot(
                    owner_id=owner,
                    binder_id=binder_id,
                    printing_id=uuid.UUID(catalog[0]),
                    source_observation_id=observation_id,
                    quantity_remaining=1,
                    split_parent_id=uuid.UUID(lot_id),
                )
            )
    body = {"printing_ids": [catalog[0]], "action": "finish", "finish": "foil"}
    plan = client.post("/api/v1/collection/bulk/preview", json=body).json()
    response = client.post(
        "/api/v1/collection/bulk/apply", headers=key(), json={**body, "token": plan["token"]}
    )
    assert response.status_code == 200, response.text
    with session_factory()() as db:
        observation = db.get(Observation, observation_id)
        assert observation.finish == "foil" and observation.version == 2


def test_condition_and_notes_are_saved_versioned_and_audited(clients, catalog):
    client, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    lot = client.get("/api/v1/collection").json()["items"][0]
    body = {
        "expected_version": lot["version"],
        "printing_id": catalog[0],
        "finish": "unknown",
        "condition": "NM",
        "notes": "Ready for my commander deck",
    }
    receipt, path = key(), f"/api/v1/collection/{lot['id']}/details"
    response = client.post(path, headers=receipt, json=body)
    assert response.status_code == 200, response.text
    assert response.json()["condition"] == "NM" and response.json()["notes"] == body["notes"]
    assert client.post(path, headers=receipt, json=body).json() == response.json()
    with session_factory()() as db:
        event = db.scalar(
            select(InventoryEvent).where(
                InventoryEvent.lot_id == uuid.UUID(lot["id"]), InventoryEvent.kind == "CORRECT_CARD"
            )
        )
        assert (
            event.detail["after"]["condition"] == "NM"
            and event.detail["after"]["notes"] == body["notes"]
        )


def test_details_receipts_keep_the_pre_upgrade_fingerprint(clients, catalog):
    client, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "1"}]))
    lot = client.get("/api/v1/collection").json()["items"][0]
    body = {"expected_version": lot["version"], "printing_id": catalog[0], "finish": "unknown"}
    path, receipt = f"/api/v1/collection/{lot['id']}/details", key()
    response = client.post(path, headers=receipt, json=body)
    assert response.status_code == 200, response.text
    with session_factory()() as db:
        event = db.scalar(
            select(InventoryEvent).where(
                InventoryEvent.lot_id == uuid.UUID(lot["id"]), InventoryEvent.kind == "CORRECT_CARD"
            )
        )
        assert event.detail["request_hash"] == fingerprint(body)
    assert client.post(path, headers=receipt, json=body).json() == response.json()
