import io
import uuid
from datetime import timedelta

import numpy as np
import pytest
from conftest import accept, upload
from PIL import Image
from test_collections import catalog as catalog
from test_collections import key
from test_scan_batches import approve, prepared, result

from scanner import detection, recognition, storage
from scanner.db import session_factory
from scanner.models import InventoryLot, Job, Observation, Scan, User, now
from scanner.scan_work import recognize_one
from scanner.worker import claim, process_job


def marked_card():
    image = Image.new("RGB", (600, 840), "red")
    image.paste("lime", (300, 0, 600, 420))
    image.paste("blue", (0, 420, 300, 840))
    image.paste("yellow", (300, 420, 600, 840))
    return image


def jpeg(image):
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


def assert_upright(data):
    with Image.open(io.BytesIO(data)) as image:
        assert image.size == (600, 840)
        for point, color in (
            ((150, 210), (255, 0, 0)),
            ((450, 210), (0, 255, 0)),
            ((150, 630), (0, 0, 255)),
            ((450, 630), (255, 255, 0)),
        ):
            assert max(abs(a - b) for a, b in zip(image.getpixel(point), color, strict=True)) < 8


@pytest.mark.parametrize("start", range(4))
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("landscape", [False, True])
def test_manual_crop_is_independent_of_first_corner_and_winding(start, reverse, landscape):
    image = marked_card()
    if landscape:
        image = image.transpose(Image.Transpose.ROTATE_270)
    polygon = np.array([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    polygon = np.roll(polygon[::-1] if reverse else polygon, start, axis=0)
    assert detection.polygon_valid(polygon)
    assert_upright(detection.crop_region(np.asarray(image), polygon))


def test_manual_outline_upload_uses_the_same_orientation_as_automatic_crops(clients, monkeypatch):
    client, owner = clients()
    monkeypatch.setattr(detection, "detect_regions", lambda _: [])
    scan_id = upload(client, jpeg(marked_card()))
    process_job(accept(client, scan_id)["job_id"])
    # Start at the lower right and go counterclockwise, as on a phone screen.
    polygon = [[0.9, 0.9], [0.9, 0.1], [0.1, 0.1], [0.1, 0.9]]
    headers = key()
    url = f"/api/v1/scans/{scan_id}/observations"
    added = client.post(url, headers=headers, json={"polygon": polygon})
    assert added.status_code == 201
    assert client.post(url, headers=headers, json={"polygon": polygon}).json() == added.json()
    item = client.get(url).json()["items"][0]
    assert_upright(client.get(item["crop_url"]).content)
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 1


def test_saved_recognition_rotation_is_applied_to_existing_review_images(clients):
    client, _ = clients()
    outsider, _ = clients()
    scan_id, _, rows = prepared(client)
    raw = jpeg(marked_card().transpose(Image.Transpose.ROTATE_180))
    with session_factory()() as db, db.begin():
        row = db.get(Observation, uuid.UUID(rows[0]["id"]))
        source_key = row.crop_key
        storage.put(source_key, raw, "image/jpeg")
        row.recognition = {"status": "NO_MATCH", "rotation": 180, "candidates": []}
    item = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    response = client.get(item["crop_url"])
    assert_upright(response.content)
    assert response.headers["cache-control"] == "no-store"
    assert outsider.get(item["crop_url"]).status_code == 404
    obj = storage.get(source_key)
    try:
        assert obj["Body"].read() == raw
    finally:
        obj["Body"].close()
    with session_factory()() as db, db.begin():
        db.get(Scan, uuid.UUID(scan_id)).expires_at = now() - timedelta(seconds=1)
    assert client.get(item["crop_url"]).status_code == 404


@pytest.mark.parametrize("orientation,expected", [(None, 180), (180, 180), (0, 0)])
def test_recognition_respects_manual_orientation_instead_of_flipping_it_back(
    monkeypatch, orientation, expected
):
    monkeypatch.setattr(recognition, "catalog_index", lambda: {"syntheticfixture": []})

    def read(image, *args, **kwargs):
        red, green, blue = image.getpixel((150, 210))
        return "Synthetic Fixture" if red > 240 and green < 15 and blue < 15 else "unreadable"

    monkeypatch.setattr(recognition, "read_text", read)
    data = jpeg(marked_card().transpose(Image.Transpose.ROTATE_180))
    found = recognition.recognize(data, orientation=orientation)
    assert found["rotation"] == expected
    assert found["title_text"][0] == ("Synthetic Fixture" if expected else "unreadable")


def test_flip_is_durable_idempotent_and_does_not_charge_a_guest_again(clients, monkeypatch):
    client, owner = clients(scan_cards_used=98)
    outsider, _ = clients()
    scan_id, job_id, rows = prepared(client)
    row = rows[0]
    with session_factory()() as db, db.begin():
        saved = db.get(Observation, uuid.UUID(row["id"]))
        saved.recognition = {"status": "NO_MATCH", "rotation": 180, "candidates": []}
        original_key = saved.crop_key
    url = f"/api/v1/scans/{scan_id}/observations/{row['id']}/orientation"
    body = {"expected_version": row["version"], "rotation": 0}
    headers = key()
    assert outsider.put(url, headers=headers, json=body).status_code == 404
    assert client.put(url, headers=key(), json={**body, "rotation": 90}).status_code == 422
    assert client.put(url, headers=key(), json={**body, "expected_version": 99}).status_code == 409
    response = client.put(url, headers=headers, json=body)
    assert response.status_code == 200
    assert client.put(url, headers=headers, json=body).json() == response.json()
    assert client.put(url, headers=headers, json={**body, "rotation": 180}).status_code == 409
    orientations = []

    def recognize(*args, orientation=None, **kwargs):
        orientations.append(orientation)
        return {"status": "NO_MATCH", "rotation": orientation or 0, "candidates": []}

    monkeypatch.setattr(recognition, "recognize", recognize)
    process_job(job_id)
    process_job(job_id)
    assert orientations == [0, None]
    assert client.put(url, headers=headers, json=body).json() == response.json()
    item = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    assert item["rotation"] == 0 and item["recognition"]["status"] == "NO_MATCH"
    assert not any(name.startswith("_") for name in item["recognition"])
    assert client.get("/api/v1/collection").json()["copies"] == 0
    # Rechecking the whole photo must not replace a deliberately oriented crop.
    assert (
        client.post(
            f"/api/v1/scans/{scan_id}/identify", headers=key(), json={"find_missing": True}
        ).status_code
        == 202
    )
    process_job(job_id)
    with session_factory()() as db:
        saved = db.get(Observation, uuid.UUID(row["id"]))
        assert saved.crop_key == original_key and saved.recognition["_orientation"] == 0
        assert db.get(User, owner).scan_cards_used == 100


def test_flip_fences_an_in_flight_recognition_result(clients, catalog, monkeypatch):
    client, owner = clients()
    scan_id, job_id, rows = prepared(client)
    claimed = claim(uuid.UUID(job_id))
    row = rows[0]

    def recognize(*args, **kwargs):
        response = client.put(
            f"/api/v1/scans/{scan_id}/observations/{row['id']}/orientation",
            headers=key(),
            json={"expected_version": row["version"], "rotation": 180},
        )
        assert response.status_code == 200
        return result(catalog[0])

    monkeypatch.setattr(recognition, "recognize", recognize)
    recognize_one(claimed)
    item = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    assert item["rotation"] == 180 and item["candidates"] == []
    assert client.get("/api/v1/collection").json()["copies"] == 0
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 2


def test_flipping_an_imported_photo_does_not_change_its_collection_copy(clients, catalog):
    client, _ = clients()
    scan_id, job_id, rows = prepared(client)
    assert approve(client, scan_id, rows[:1], catalog[0]).status_code == 200
    item = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    with session_factory()() as db:
        before = db.get(Job, uuid.UUID(job_id)).state
        lot_version = db.get(InventoryLot, uuid.UUID(item["lot"]["id"])).version
    response = client.put(
        f"/api/v1/scans/{scan_id}/observations/{item['id']}/orientation",
        headers=key(),
        json={"expected_version": item["version"], "rotation": 180},
    )
    assert response.status_code == 200
    changed = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    assert changed["rotation"] == 180 and changed["state"] == "COMMITTED"
    assert changed["lot"] == item["lot"]
    assert client.get("/api/v1/collection").json()["copies"] == 1
    with session_factory()() as db:
        assert db.get(Job, uuid.UUID(job_id)).state == before
        assert db.get(InventoryLot, uuid.UUID(item["lot"]["id"])).version == lot_version
