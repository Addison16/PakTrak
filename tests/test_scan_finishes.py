import uuid

import pytest
from conftest import create
from sqlalchemy import select
from test_collections import catalog as catalog
from test_collections import geometry_photo, key
from test_scan_batches import approve, deletion, prepared, result

from scanner import detection, recognition
from scanner.db import session_factory
from scanner.models import InventoryEvent, InventoryLot, Job, Observation, Printing, Scan, User
from scanner.worker import process_job


def identified(client, catalog, monkeypatch, foil_count=1, scores=(0.95, 0.88)):
    scan_id, job_id, _ = prepared(client, foil_count=foil_count)
    responses = []
    for score in scores:
        response = result(catalog[0])
        response["candidates"][0]["match_score"] = score
        responses.append(response)
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: responses.pop(0))
    for _ in scores:
        process_job(job_id)
    return scan_id, client.get(f"/api/v1/scans/{scan_id}/observations").json()


def selection(client, scan_id, data, foil_ids, etched_ids=None, headers=None, **overrides):
    body = {
        "foil_count": len(foil_ids),
        "foil_ids": foil_ids,
        "etched_ids": etched_ids or [],
        "token": data["finishes"]["token"],
    }
    body.update(overrides)
    return client.post(f"/api/v1/scans/{scan_id}/finishes", headers=headers or key(), json=body)


def test_mixed_auto_and_review_finishes_are_atomic_replayable_and_source_preserving(
    clients, catalog, monkeypatch
):
    client, _ = clients()
    outsider, _ = clients()
    scan_id, data = identified(client, catalog, monkeypatch)
    auto, pending = data["items"]
    assert auto["state"] == "COMMITTED" and auto["recognition"]["auto_imported"]
    assert pending["state"] == "NEEDS_REVIEW"  # exactly 88% still needs approval
    assert data["summary"]["auto_add_enabled"] and data["summary"]["auto_add_threshold"] == 0.88
    assert auto["lot"]["finish"] == pending["finish"] == "unknown"
    assert data["finishes"]["foil_count"] == 1 and not data["finishes"]["confirmed"]
    with session_factory()() as db:
        event = db.scalar(
            select(InventoryEvent).where(InventoryEvent.operation_key == f"add:{auto['id']}")
        )
        assert event.kind == "ADD_SCAN_AUTO"
        assert event.detail["match_score"] == 0.95 and event.detail["threshold"] == 0.88
        assert "p_exact" not in event.detail
    assert selection(outsider, scan_id, data, [auto["id"]]).status_code == 404
    headers = key()
    response = selection(client, scan_id, data, [auto["id"]], headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"foil_cards": 1, "nonfoil_cards": 1}
    assert selection(client, scan_id, data, [auto["id"]], headers=headers).json() == response.json()
    assert selection(client, scan_id, data, [pending["id"]], headers=headers).status_code == 409
    updated = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert updated["finishes"]["confirmed"]
    assert updated["items"][0]["lot"]["finish"] == "foil"
    assert updated["items"][1]["finish"] == "nonfoil"
    assert client.get("/api/v1/collection").json()["copies"] == 1
    assert (
        approve(client, scan_id, [updated["items"][1]], catalog[0], finish="nonfoil").status_code
        == 200
    )
    with session_factory()() as db:
        lot = db.get(InventoryLot, uuid.UUID(auto["lot"]["id"]))
        assert str(lot.source_observation_id) == auto["id"]
        assert lot.quantity_remaining == 1 and lot.finish == "foil"
        events = list(
            db.scalars(
                select(InventoryEvent).where(
                    InventoryEvent.lot_id == lot.id, InventoryEvent.kind == "SET_SCAN_FINISH"
                )
            )
        )
        assert len(events) == 1 and events[0].delta == 0
    assert deletion(client, scan_id).json()["copies_removed"] == 2
    assert selection(client, scan_id, updated, []).status_code == 404


@pytest.mark.parametrize("foil_count", [0, None])
def test_zero_foils_automatically_use_nonfoil_and_survive_recheck(
    clients, catalog, monkeypatch, foil_count
):
    client, _ = clients()
    scan_id, data = identified(client, catalog, monkeypatch, foil_count=foil_count)
    assert data["finishes"]["confirmed"]
    assert all(row["finish"] == "nonfoil" for row in data["items"])
    assert data["items"][0]["lot"]["finish"] == "nonfoil"
    assert client.get(f"/api/v1/scans/{scan_id}").json()["foil_count"] == 0
    assert (
        client.post(
            f"/api/v1/scans/{scan_id}/identify", headers=key(), json={"find_missing": False}
        ).status_code
        == 202
    )
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: result(catalog[0]))
    with session_factory()() as db:
        job_id = str(db.scalar(select(Job.id).where(Job.scan_id == uuid.UUID(scan_id))))
    process_job(job_id)
    process_job(job_id)
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert all(row["lot"]["finish"] == "nonfoil" for row in data["items"])
    assert client.get("/api/v1/collection").json()["copies"] == 2


def test_finish_selection_validates_count_membership_conflicts_and_supported_printings(
    clients, catalog, monkeypatch
):
    client, _ = clients()
    scan_id, data = identified(client, catalog, monkeypatch)
    first, second = data["items"]
    for ids, extra in [
        ([first["id"]], {"foil_count": 2}),
        ([first["id"], first["id"]], {}),
        ([str(uuid.uuid4())], {}),
        ([], {"etched_ids": [first["id"]]}),
    ]:
        assert selection(client, scan_id, data, ids, **extra).status_code == 422
    # Catalog finish conflicts must roll back the entire batch, including earlier rows.
    with session_factory()() as db, db.begin():
        card = db.get(Printing, uuid.UUID(catalog[1]))
        original_finishes = list(card.finishes)
        card.finishes = ["nonfoil"]
        db.get(Observation, uuid.UUID(second["id"])).recognition = result(catalog[1])
    try:
        response = selection(client, scan_id, data, [second["id"]])
        assert response.status_code == 422 and "Card 2" in response.json()["detail"]
        assert (
            client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]["finish"]
            == "unknown"
        )
    finally:
        with session_factory()() as db, db.begin():
            db.get(Printing, uuid.UUID(catalog[1])).finishes = original_finishes
    # Editing an imported copy makes an old batch snapshot unsafe to overwrite.
    response = client.post(
        f"/api/v1/collection/{first['lot']['id']}/details",
        headers=key(),
        json={"expected_version": 1, "printing_id": catalog[0], "finish": "etched"},
    )
    assert response.status_code == 200
    assert selection(client, scan_id, data, [first["id"]]).status_code == 409
    updated = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert updated["items"][0]["finish"] == "etched"
    assert (
        selection(client, scan_id, updated, [first["id"]], etched_ids=[first["id"]]).status_code
        == 200
    )
    assert client.get(f"/api/v1/scans/{scan_id}/observations").json()["finishes"]["etched_ids"] == [
        first["id"]
    ]


def test_finish_selection_waits_for_identification_and_legacy_scans_stay_unknown(clients):
    client, _ = clients()
    scan_id, _, _ = prepared(client)
    with session_factory()() as db, db.begin():
        db.get(Scan, uuid.UUID(scan_id)).foil_count = None
        for row in db.scalars(select(Observation).where(Observation.scan_id == uuid.UUID(scan_id))):
            row.finish = "unknown"
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert data["finishes"]["foil_count"] is None
    assert all(row["finish"] == "unknown" for row in data["items"])
    assert selection(client, scan_id, data, []).status_code == 409


def test_omitted_foil_count_defaults_to_nonfoil_without_changing_upload_receipts(clients):
    client, _ = clients()
    photo, request_key = geometry_photo(), str(uuid.uuid4())
    first = create(client, photo, key=request_key)
    assert first.status_code == 201 and first.json()["foil_count"] == 0
    retry = create(client, photo, key=request_key)
    assert retry.status_code == 200 and retry.json()["id"] == first.json()["id"]
    # Old omitted-count requests keep their original receipt and saved plan.
    with session_factory()() as db, db.begin():
        db.get(Scan, uuid.UUID(first.json()["id"])).foil_count = None
    assert create(client, photo, key=request_key).json()["foil_count"] is None
    scan_id, _, rows = prepared(client)
    assert all(row["finish"] == "nonfoil" for row in rows)
    assert client.get(f"/api/v1/scans/{scan_id}/observations").json()["finishes"]["confirmed"]


@pytest.mark.parametrize("method", ["outline", "recheck"])
@pytest.mark.parametrize("selected", [False, True])
def test_newly_found_cards_inherit_nonfoil_only_after_all_foils_are_selected(
    clients, catalog, monkeypatch, method, selected
):
    client, owner = clients()
    scan_id, data = identified(client, catalog, monkeypatch, foil_count=1)
    if selected:
        assert selection(client, scan_id, data, [data["items"][0]["id"]]).status_code == 200
        data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    original_ids = {row["id"] for row in data["items"]}
    original_lot = data["items"][0]["lot"]
    polygon = [[0.77, 0.65], [0.96, 0.65], [0.96, 0.98], [0.77, 0.98]]
    detector = detection.detect_regions
    monkeypatch.setattr(
        detection,
        "detect_regions",
        lambda photo: [*detector(photo), {"polygon": polygon, "crop": geometry_photo()}],
    )
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: result(catalog[0]))
    with session_factory()() as db:
        job_id = str(db.scalar(select(Job.id).where(Job.scan_id == uuid.UUID(scan_id))))
    headers = key()
    for _ in range(2):
        if method == "outline":
            response = client.post(
                f"/api/v1/scans/{scan_id}/observations", headers=headers, json={"polygon": polygon}
            )
            assert response.status_code in (200, 201), response.text
        else:
            response = client.post(
                f"/api/v1/scans/{scan_id}/identify", headers=key(), json={"find_missing": True}
            )
            assert response.status_code == 202, response.text
        for _ in range(4):
            process_job(job_id)
        updated = client.get(f"/api/v1/scans/{scan_id}/observations").json()
        new_rows = [row for row in updated["items"] if row["id"] not in original_ids]
        assert len(new_rows) == 1
        new_card = new_rows[0]
        assert new_card["finish"] == ("nonfoil" if selected else "unknown")
        assert new_card["lot"]["finish"] == new_card["finish"]
        assert updated["items"][0]["lot"] == original_lot
        assert updated["finishes"]["confirmed"] is selected
        # An outline queues only its new card; a full recheck also retries the
        # original 88% suggestion, which now receives the stronger test match.
        assert client.get("/api/v1/collection").json()["copies"] == (
            2 if method == "outline" else 3
        )
        with session_factory()() as db:
            assert db.get(User, owner).scan_cards_used == 3


def test_new_card_uses_current_imported_foil_selection_after_a_collection_edit(
    clients, catalog, monkeypatch
):
    client, _ = clients()
    scan_id, data = identified(client, catalog, monkeypatch, foil_count=1)
    assert selection(client, scan_id, data, [data["items"][0]["id"]]).status_code == 200
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    lot = data["items"][0]["lot"]
    assert (
        client.post(
            f"/api/v1/collection/{lot['id']}/details",
            headers=key(),
            json={
                "expected_version": lot["version"],
                "printing_id": catalog[0],
                "finish": "nonfoil",
            },
        ).status_code
        == 200
    )
    response = client.post(
        f"/api/v1/scans/{scan_id}/observations",
        headers=key(),
        json={"polygon": [[0.77, 0.65], [0.96, 0.65], [0.96, 0.98], [0.77, 0.98]]},
    )
    assert response.status_code == 201, response.text
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert data["items"][-1]["finish"] == "unknown"
    assert not data["finishes"]["confirmed"]


@pytest.mark.parametrize("count", [-1, 33, 1.5, True, "2"])
def test_preupload_foil_count_is_a_bounded_integer(clients, count):
    client, _ = clients()
    assert create(client, geometry_photo(), foil_count=count).status_code == 422


def test_preupload_foil_count_is_part_of_idempotent_request(clients):
    client, _ = clients()
    photo, request_key = geometry_photo(), str(uuid.uuid4())
    first = create(client, photo, key=request_key, foil_count=2)
    assert first.status_code == 201 and first.json()["foil_count"] == 2
    assert create(client, photo, key=request_key, foil_count=2).status_code == 200
    assert create(client, photo, key=request_key, foil_count=1).status_code == 409
    with session_factory()() as db:
        assert db.get(Scan, uuid.UUID(first.json()["id"])).foil_count == 2
