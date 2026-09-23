import io
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from conftest import accept, upload
from PIL import Image, ImageDraw
from sqlalchemy import select
from test_adjacent_detection import adjacent_photo
from test_borderless_detection import borderless_photo
from test_collections import catalog as catalog
from test_collections import commit, geometry_photo, key, preview

from scanner import detection, recognition, recognition_policy
from scanner.db import session_factory
from scanner.models import (
    CardPrice,
    InventoryEvent,
    InventoryLot,
    Job,
    Observation,
    Scan,
    User,
    now,
)
from scanner.scan_work import recognize_one
from scanner.worker import claim, finish, process_job


def prepared(client, **options):
    scan_id = upload(client, geometry_photo(), **options)
    job_id = accept(client, scan_id)["job_id"]
    process_job(job_id)
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert len(data["items"]) == 2
    return scan_id, job_id, data["items"]


def approve(client, scan_id, rows, printing_id, finish="nonfoil", headers=None):
    body = {
        "items": [
            {
                "observation_id": row["id"],
                "expected_version": row["version"],
                "printing_id": printing_id,
                "finish": finish,
            }
            for row in rows
        ],
        "binder": "Red binder",
    }
    return client.post(f"/api/v1/scans/{scan_id}/approve", json=body, headers=headers or key())


def deletion(client, scan_id, preview=None):
    preview = preview or client.get(f"/api/v1/scans/{scan_id}/deletion-preview").json()
    return client.request(
        "DELETE",
        f"/api/v1/scans/{scan_id}",
        json={"confirmed": True, "token": preview["token"]},
        headers=key(),
    )


def test_batch_list_previews_are_bounded_owned_and_follow_saved_decisions(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    scan_id, _, rows = prepared(client)
    assert approve(client, scan_id, rows[:1], catalog[0]).status_code == 200
    with session_factory()() as db, db.begin():
        ignored = db.get(Observation, uuid.UUID(rows[1]["id"]))
        ignored.state = "IGNORED"
        for index in range(2, 10):
            db.add(
                Observation(
                    id=uuid.uuid4(),
                    scan_id=uuid.UUID(scan_id),
                    region_index=index,
                    polygon=rows[0]["polygon"],
                    detector_version="preview-fixture",
                    recognition=result(catalog[1]),
                )
            )
    listed = client.get("/api/v1/scans").json()["items"][0]
    assert listed["id"] == scan_id
    assert listed["summary"]["cards"] == 9
    assert listed["summary"]["needs_review"] == 8
    assert len(listed["preview_cards"]) == 6
    assert rows[1]["id"] not in [item["id"] for item in listed["preview_cards"]]
    assert listed["preview_cards"][0]["name"] == "Synthetic Fixture Card"
    assert listed["preview_cards"][0]["image_url"].startswith(
        f"/api/v1/scans/{scan_id}/observations/"
    )
    assert other.get("/api/v1/scans").json()["items"] == []
    assert other.get(listed["preview_cards"][0]["image_url"]).status_code == 404
    assert other.get(f"/api/v1/scans/{scan_id}").status_code == 404
    with session_factory()() as db, db.begin():
        db.get(Scan, uuid.UUID(scan_id)).expires_at = now() - timedelta(seconds=1)
    expired = client.get(f"/api/v1/scans/{scan_id}").json()
    assert all(item["image_url"] is None for item in expired["preview_cards"])
    assert expired["summary"]["imported"] == 1  # expired photos retain saved decisions


def test_delete_only_source_copies_with_warning_and_no_quota_refund(clients, catalog):
    client, owner_id = clients()
    other, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "3"}]))
    scan_id, job_id, rows = prepared(client)
    second_id, _, other_rows = prepared(client)
    assert approve(client, scan_id, rows, catalog[0]).status_code == 200
    assert approve(client, second_id, other_rows, catalog[0]).status_code == 200
    assert client.get("/api/v1/collection").json()["copies"] == 7
    info = client.get(f"/api/v1/scans/{scan_id}/deletion-preview").json()
    assert info["copies"] == 2 and "Guest scan allowance is not restored" in info["warning"]
    assert other.get(f"/api/v1/scans/{scan_id}/deletion-preview").status_code == 404
    assert deletion(other, scan_id, info).status_code == 404
    with session_factory()() as db:
        lots = list(
            db.scalars(
                select(InventoryLot)
                .where(InventoryLot.source_observation_id.in_([uuid.UUID(r["id"]) for r in rows]))
                .order_by(InventoryLot.id)
            )
        )
        first, second = lots[0].id, lots[1].id
    # Corrections and moves must retain the source association used by deletion.
    response = client.post(
        f"/api/v1/collection/{first}/details",
        headers=key(),
        json={"expected_version": 1, "printing_id": catalog[1], "finish": "foil"},
    )
    assert response.status_code == 200, response.text
    box = client.post(
        "/api/v1/binders", json={"name": "Box 4", "kind": "box"}, headers=key()
    ).json()
    response = client.post(
        f"/api/v1/collection/{first}/move",
        headers=key(),
        json={"expected_version": 2, "binder_id": box["id"]},
    )
    assert response.status_code == 200
    assert (
        client.post(
            f"/api/v1/collection/{second}/quantity",
            headers=key(),
            json={"expected_version": 1, "quantity": 0},
        ).status_code
        == 200
    )
    assert deletion(client, scan_id, info).status_code == 409  # stale confirmation cannot delete
    assert deletion(client, scan_id).json() == {"deleted": True, "copies_removed": 1}
    assert deletion(client, scan_id, info).json()["copies_removed"] == 1  # lost response replay
    assert client.get("/api/v1/collection").json()["copies"] == 5
    assert client.get(f"/api/v1/scans/{scan_id}").status_code == 404
    assert client.get(f"/api/v1/scans/{scan_id}/observations").status_code == 404
    assert client.get(rows[0]["crop_url"]).status_code == 404
    assert scan_id not in [s["id"] for s in client.get("/api/v1/scans").json()["items"]]
    assert (
        client.post(
            f"/api/v1/collection/{first}/details",
            headers=key(),
            json={"expected_version": 4, "printing_id": catalog[0], "finish": "nonfoil"},
        ).status_code
        == 404
    )
    process_job(job_id)
    assert client.get("/api/v1/collection").json()["copies"] == 5
    with session_factory()() as db:
        assert db.get(User, owner_id).scan_cards_used == 4
        assert (
            len(
                list(
                    db.scalars(
                        select(InventoryEvent).where(
                            InventoryEvent.lot_id == first, InventoryEvent.kind == "DELETE_SCAN"
                        )
                    )
                )
            )
            == 1
        )


def test_batch_approval_replay_and_atomic_conflicts(clients, catalog):
    client, _ = clients()
    scan_id, _, rows = prepared(client)
    headers = key()
    response = approve(client, scan_id, rows, catalog[0], headers=headers)
    assert response.status_code == 200, response.text
    assert approve(client, scan_id, rows, catalog[0], headers=headers).status_code == 200
    assert approve(client, scan_id, rows, catalog[1], headers=headers).status_code == 409
    assert client.get("/api/v1/collection").json()["copies"] == 2
    another, _, rows = prepared(client)
    rows[1]["version"] += 1
    assert approve(client, another, rows, catalog[0]).status_code == 409
    assert client.get("/api/v1/collection").json()["copies"] == 2


def result(card_id):
    return {
        "status": "MATCHED",
        "version": "test-matcher",
        "p_exact": None,
        "candidates": [{"printing_id": card_id, "match_score": 0.99, "evidence": []}],
    }


def test_delete_while_recognizing_fences_auto_import_and_old_attempt(clients, catalog, monkeypatch):
    client, _ = clients()
    scan_id, job_id, _ = prepared(client)
    claimed = claim(uuid.UUID(job_id))

    def recognize(*args, **kwargs):
        assert deletion(client, scan_id).status_code == 200
        return result(catalog[0])

    monkeypatch.setattr(recognition, "recognize", recognize)
    recognize_one(claimed)
    assert finish(claimed, {}) is False
    process_job(job_id)
    assert client.get("/api/v1/collection").json()["copies"] == 0
    with session_factory()() as db:
        assert db.get(Job, uuid.UUID(job_id)).error_code == "BATCH_DELETED"


def test_server_checkpoints_continue_without_client_and_do_not_duplicate(
    clients, catalog, monkeypatch
):
    client, _ = clients()
    scan_id, job_id, _ = prepared(client)
    monkeypatch.setattr(recognition, "recognize", lambda *args, **kwargs: result(catalog[0]))
    client.close()
    process_job(job_id)
    with session_factory()() as db:
        job = db.get(Job, uuid.UUID(job_id))
        assert job.state == "QUEUED" and job.result["progress"]["done"] == 1
    process_job(job_id)
    process_job(job_id)
    with session_factory()() as db:
        job = db.get(Job, uuid.UUID(job_id))
        assert job.state == "SUCCEEDED" and job.result["cards_added"] == 2
        lots = list(
            db.scalars(
                select(InventoryLot)
                .join(Observation, InventoryLot.source_observation_id == Observation.id)
                .where(Observation.scan_id == uuid.UUID(scan_id))
            )
        )
        assert len(lots) == 2 and sum(lot.quantity_remaining for lot in lots) == 2


def test_crop_edit_fences_old_recognition_without_charging_again(clients, catalog, monkeypatch):
    client, owner = clients()
    scan_id, job_id, rows = prepared(client)
    claimed = claim(uuid.UUID(job_id))
    row = rows[0]
    polygon = [[x + 0.003, y] for x, y in row["polygon"]]

    def recognize(*args, **kwargs):
        response = client.put(
            f"/api/v1/scans/{scan_id}/observations/{row['id']}/geometry",
            headers=key(),
            json={"polygon": polygon, "expected_version": row["version"]},
        )
        assert response.status_code == 200, response.text
        return result(catalog[0])

    monkeypatch.setattr(recognition, "recognize", recognize)
    recognize_one(claimed)
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert data["items"][0]["candidates"] == []
    assert data["items"][0]["polygon"] == polygon
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 2


def test_manual_region_quota_validation_and_retry(clients):
    client, owner = clients(scan_cards_used=97)
    scan_id, _, rows = prepared(client)
    polygon = [[0.77, 0.65], [0.96, 0.65], [0.96, 0.98], [0.77, 0.98]]
    headers = key()
    url = f"/api/v1/scans/{scan_id}/observations"
    first = client.post(url, headers=headers, json={"polygon": polygon})
    assert first.status_code == 201, first.text
    assert client.post(url, headers=headers, json={"polygon": polygon}).json() == first.json()
    assert client.post(url, headers=key(), json={"polygon": rows[0]["polygon"]}).status_code == 409
    assert (
        client.post(
            url,
            headers=key(),
            json={"polygon": [[0.3, 0.65], [0.5, 0.65], [0.5, 0.98], [0.3, 0.98]]},
        ).status_code
        == 403  # Exhausted account allowance; duplicate geometry remains a 409 above.
    )
    assert (
        client.post(url, headers=key(), json={"polygon": [[0, 0], [1], [1, 1], [0, 1]]}).status_code
        == 422
    )
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 100


def test_crop_edit_retry_survives_recognition_checkpoint(clients, monkeypatch):
    client, owner = clients()
    scan_id, job_id, rows = prepared(client)
    row = rows[0]
    url = f"/api/v1/scans/{scan_id}/observations/{row['id']}/geometry"
    data = {
        "polygon": [[x + 0.003, y] for x, y in row["polygon"]],
        "expected_version": row["version"],
    }
    headers = key()
    first = client.put(url, headers=headers, json=data)
    assert first.status_code == 200
    monkeypatch.setattr(
        recognition, "recognize", lambda *a, **k: {"status": "NO_MATCH", "candidates": []}
    )
    process_job(job_id)
    assert client.put(url, headers=headers, json=data).json() == first.json()
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 2


def test_printing_preview_requires_owned_live_batch(clients, catalog, monkeypatch):
    from scanner import scan_batches

    client, _ = clients()
    outsider, _ = clients()
    scan_id, _, _ = prepared(client)
    monkeypatch.setattr(
        scan_batches, "load_image", lambda *a, **k: (b"image-fixture", "image/jpeg", "digest")
    )
    url = f"/api/v1/scans/{scan_id}/reference/{catalog[0]}/image"
    assert client.get(url).content == b"image-fixture"
    assert outsider.get(url).status_code == 404
    assert deletion(client, scan_id).status_code == 200
    assert client.get(url).status_code == 404


def test_batch_estimates_include_suggestions_and_keep_unknown_finish_range(clients, catalog):
    client, _ = clients()
    scan_id, _, rows = prepared(client, foil_count=1)
    with session_factory()() as db, db.begin():
        for row in rows:
            db.get(Observation, uuid.UUID(row["id"])).recognition = result(catalog[0])
        for finish, amount in [("nonfoil", "2.50"), ("foil", "4.00")]:
            db.merge(
                CardPrice(
                    printing_id=uuid.UUID(catalog[0]),
                    provider="tcgplayer",
                    finish=finish,
                    amount=Decimal(amount),
                )
            )
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert Decimal(data["summary"]["value_min"]) == 5
    assert Decimal(data["summary"]["value_max"]) == 8
    assert data["summary"]["priced_cards"] == 2
    assert data["summary"]["imported"] == 0
    assert approve(client, scan_id, rows, catalog[0]).status_code == 200
    data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
    assert Decimal(data["summary"]["value_min"]) == Decimal(data["summary"]["value_max"]) == 5
    assert (
        client.get(f"/api/v1/scans/{scan_id}/observations?provider=manapool").json()["summary"][
            "value_min"
        ]
        is None
    )


@pytest.mark.parametrize(
    "strength,allowed",
    [
        (None, False),
        (0.88, False),
        (0.880001, True),
        (0.879999, False),
        (1, True),
        (1.01, False),
        (True, False),
        (float("nan"), False),
        (float("inf"), False),
        ("0.95", False),
    ],
)
def test_auto_import_strict_match_strength_threshold(strength, allowed):
    value = result(str(uuid.uuid4()))
    value["candidates"][0]["match_score"] = strength
    assert recognition_policy.may_auto_import(value) is allowed
    value["status"] = "NO_MATCH"
    assert not recognition_policy.may_auto_import(value)


@pytest.mark.parametrize(
    "candidates", [None, [], [{}], [None], [{"printing_id": "invalid", "match_score": 1}]]
)
def test_auto_import_requires_valid_server_candidate(candidates):
    assert not recognition_policy.may_auto_import({"status": "MATCHED", "candidates": candidates})


def test_name_retrieval_does_not_replace_full_title_with_shorter_card_name():
    index = {"ultrondrone": [], "drone": [], "mockingbirdaceagent": [], "mockingbird": []}
    assert recognition.name_matches(["Witton Drone tS"], index)[0][0] == "ultrondrone"
    assert (
        recognition.name_matches(["Mockingbird, Ace Agent Ge"], index)[0][0]
        == "mockingbirdaceagent"
    )


def test_fifteen_separated_synthetic_cards_are_distinct_even_when_repeated():
    image = Image.new("RGB", (1400, 1800), "#997555")
    draw = ImageDraw.Draw(image)
    for index in range(15):
        x, y = 70 + (index % 4) * 330, 70 + (index // 4) * 420
        draw.rounded_rectangle((x, y, x + 230, y + 322), radius=12, fill="#171717")
        draw.rectangle((x + 14, y + 16, x + 216, y + 306), fill="#ede9da")
        draw.rectangle((x + 20, y + 42, x + 210, y + 177), fill="#4d7489")
    output = io.BytesIO()
    image.save(output, "JPEG", quality=90)
    regions = detection.detect_regions(output.getvalue())
    assert len(regions) == 15
    for index, region in enumerate(regions):
        assert all(
            detection.overlap(region["polygon"], other["polygon"]) < 0.01
            for other in regions[index + 1 :]
        )


def test_nearly_coincident_outlines_do_not_become_extra_cards():
    # Numerical regression: OpenCV mismeasures these almost identical quads at
    # unit-square scale. Pixel-scale intersections preserve the physical region.
    import numpy as np

    first = (
        np.array([[930, 462], [1162, 450], [1174, 775], [940, 789]], dtype=np.float32)
        / [1350, 1800]
    ).tolist()
    second = (
        np.array([[930, 461], [1162, 447], [1176, 773], [939, 789]], dtype=np.float32)
        / [1350, 1800]
    ).tolist()
    assert detection.overlap(first, second) > 0.99
    assert detection.overlap(second, first) > 0.99


@pytest.mark.parametrize("strength", [0.77, 0.91])
def test_borderless_recheck_adds_only_missing_card_and_preserves_imports(
    clients, catalog, monkeypatch, strength
):
    client, owner = clients()
    photo, _ = borderless_photo()
    scan_id = upload(client, photo, foil_count=0)
    job_id = accept(client, scan_id)["job_id"]
    detector = detection.detect_regions
    # Simulate a saved batch from a detector that missed one physical card.
    with monkeypatch.context() as previous:
        previous.setattr(detection, "detect_regions", lambda data: detector(data)[1:])
        previous.setattr(detection, "VERSION", "previous-fixture")
        process_job(job_id)
    rows = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert len(rows) == 8
    assert approve(client, scan_id, rows, catalog[0]).status_code == 200
    process_job(job_id)
    original = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    originals = {row["id"]: row for row in original}
    suggestion = result(catalog[0])
    suggestion["candidates"][0]["match_score"] = strength
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: suggestion)
    found_ids = None
    for _ in range(2):
        assert (
            client.post(
                f"/api/v1/scans/{scan_id}/identify", headers=key(), json={"find_missing": True}
            ).status_code
            == 202
        )
        # Detection, one durable recognition checkpoint, then completion.
        for _ in range(3):
            process_job(job_id)
        data = client.get(f"/api/v1/scans/{scan_id}/observations").json()
        assert len(data["items"]) == 9
        current_ids = {row["id"] for row in data["items"]}
        if found_ids is not None:
            assert current_ids == found_ids
        found_ids = current_ids
        for row in data["items"]:
            if row["id"] in originals:
                old = originals[row["id"]]
                assert row["state"] == "COMMITTED"
                assert row["version"] == old["version"]
                assert row["polygon"] == old["polygon"]
                assert row["lot"] == old["lot"]
            else:
                assert row["state"] == ("COMMITTED" if strength > 0.88 else "NEEDS_REVIEW")
                assert row["finish"] == "nonfoil"
                assert row["candidates"][0]["match_score"] == strength
        assert client.get("/api/v1/collection").json()["copies"] == (9 if strength > 0.88 else 8)
        with session_factory()() as db:
            assert db.get(User, owner).scan_cards_used == 9
            assert db.get(Job, uuid.UUID(job_id)).state == "SUCCEEDED"


@pytest.mark.parametrize("strength", [0.77, 0.91])
def test_recheck_separates_pending_merged_cards_without_duplicate_copies_or_charges(
    clients, catalog, monkeypatch, strength
):
    client, owner = clients()
    photo, polygons = adjacent_photo()
    scan_id = upload(client, photo, foil_count=0)
    job_id = accept(client, scan_id)["job_id"]
    merged = [*polygons[0][:2].tolist(), *polygons[1][2:].tolist()]
    with monkeypatch.context() as previous:
        previous.setattr(
            detection, "detect_regions", lambda data: [{"polygon": merged, "crop": photo}]
        )
        previous.setattr(detection, "VERSION", "previous-merged-fixture")
        previous.setattr(
            recognition, "recognize", lambda *a, **k: {"status": "NO_MATCH", "candidates": []}
        )
        for _ in range(3):
            process_job(job_id)
    original = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert len(original) == 1 and original[0]["state"] == "NEEDS_REVIEW"
    assert client.get("/api/v1/collection").json()["copies"] == 0
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 1
    suggestion = result(catalog[0])
    suggestion["candidates"][0]["match_score"] = strength
    monkeypatch.setattr(recognition, "recognize", lambda *a, **k: suggestion)
    found_ids = None
    for _ in range(2):
        assert (
            client.post(
                f"/api/v1/scans/{scan_id}/identify", headers=key(), json={"find_missing": True}
            ).status_code
            == 202
        )
        for _ in range(4):
            process_job(job_id)
        rows = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
        assert len(rows) == 2
        current_ids = {row["id"] for row in rows}
        assert original[0]["id"] in current_ids
        if found_ids is not None:
            assert current_ids == found_ids
        found_ids = current_ids
        assert detection.overlap(rows[0]["polygon"], rows[1]["polygon"]) < 0.05
        for row in rows:
            assert row["state"] == ("COMMITTED" if strength > 0.88 else "NEEDS_REVIEW")
            assert row["detector_version"] == detection.VERSION
            assert row["finish"] == "nonfoil"
            assert max(detection.overlap(row["polygon"], polygon) for polygon in polygons) > 0.95
        assert client.get("/api/v1/collection").json()["copies"] == (2 if strength > 0.88 else 0)
        with session_factory()() as db:
            assert db.get(User, owner).scan_cards_used == 2
            assert db.get(Job, uuid.UUID(job_id)).state == "SUCCEEDED"
