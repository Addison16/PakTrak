import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from conftest import accept, create, upload
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from scanner import storage
from scanner.api import app
from scanner.db import session_factory
from scanner.dispatcher import dispatch_once, reconcile
from scanner.maintenance import cleanup
from scanner.models import Job, Outbox, Scan, now
from scanner.settings import get_settings
from scanner.worker import ImageRejected, claim, finish, prepare_image, process_job


def test_private_endpoints_require_login():
    with TestClient(app) as client:
        assert client.get("/api/v1/scans").status_code == 401


def test_capabilities_report_100_mib_upload_limit():
    with TestClient(app) as client:
        response = client.get("/api/v1/capabilities")
    assert response.status_code == 200
    assert response.json()["max_upload_bytes"] == 100 * 1024 * 1024
    assert response.json()["app_url"] == get_settings().app_url


def test_csrf_and_forged_owner_rejected(clients, photo):
    client, _ = clients()
    assert create(client, photo, owner_id=str(uuid.uuid4())).status_code == 422
    client.headers["X-CSRF-Token"] = "wrong"
    assert create(client, photo).status_code == 403


def test_create_idempotency_and_conflict(clients, photo):
    client, _ = clients()
    first = create(client, photo, key="stable-request-key")
    repeated = create(client, photo, key="stable-request-key")
    assert first.status_code == 201
    assert repeated.status_code == 200
    assert first.json()["id"] == repeated.json()["id"]
    assert create(client, photo, key="stable-request-key", size=len(photo) + 1).status_code == 409


def test_concurrent_same_key_creates_one_scan(clients, photo):
    client, owner = clients()
    with ThreadPoolExecutor(max_workers=5) as pool:
        responses = list(
            pool.map(lambda _: create(client, photo, key="concurrent-request"), range(5))
        )
    assert {r.status_code for r in responses} <= {200, 201}
    assert len({r.json()["id"] for r in responses}) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Scan).where(Scan.owner_id == owner)) == 1


def test_acceptance_requires_uploaded_object(clients, photo):
    client, _ = clients()
    scan_id = create(client, photo).json()["id"]
    response = client.post(
        f"/api/v1/scans/{scan_id}/finalize", headers={"Idempotency-Key": "not-uploaded-yet"}
    )
    assert response.status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(Job).where(Job.scan_id == uuid.UUID(scan_id))) is None


@pytest.mark.parametrize("content,status", [(b"not an image", 422), (b"x" * 2000, 413)])
def test_incomplete_and_oversized_uploads(clients, photo, content, status):
    client, _ = clients()
    scan_id = create(client, photo).json()["id"]
    result = client.put(
        f"/api/v1/scans/{scan_id}/upload", content=content, headers={"Content-Type": "image/jpeg"}
    )
    assert result.status_code == status


def test_signature_mismatch_rejected(clients, photo):
    client, _ = clients()
    scan_id = create(client, photo).json()["id"]
    result = client.put(
        f"/api/v1/scans/{scan_id}/upload",
        content=b"x" * len(photo),
        headers={"Content-Type": "image/jpeg"},
    )
    assert result.status_code == 415


def test_upload_retry_is_immutable(clients, photo):
    client, _ = clients()
    scan_id = upload(client, photo)
    url = f"/api/v1/scans/{scan_id}/upload"
    assert client.put(url, content=photo, headers={"Content-Type": "image/jpeg"}).status_code == 200
    altered = photo[:-1] + b"x"
    assert (
        client.put(url, content=altered, headers={"Content-Type": "image/jpeg"}).status_code == 409
    )
    accepted = accept(client, scan_id)
    assert accepted["safe_to_disconnect"]
    assert client.put(url, content=photo, headers={"Content-Type": "image/jpeg"}).status_code == 409


def test_finalization_race_and_lost_response_replay(clients, photo):
    client, _ = clients()
    scan_id = upload(client, photo)
    with ThreadPoolExecutor(max_workers=4) as pool:
        accepted = list(pool.map(lambda _: accept(client, scan_id), range(4)))
    assert len({r["job_id"] for r in accepted}) == 1
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.scan_id == uuid.UUID(scan_id)))
        assert db.get(Outbox, job.id) is not None
    assert client.get(f"/api/v1/scans/{scan_id}").json()["accepted_at"] is not None


def test_durable_acceptance_survives_publication_failure(clients, photo):
    client, _ = clients()
    accepted = accept(client, upload(client, photo))

    def unavailable(_):
        raise ConnectionError("Deliberately unavailable broker")

    with pytest.raises(ConnectionError):
        dispatch_once(publish=unavailable)
    with session_factory()() as db:
        job_id = uuid.UUID(accepted["job_id"])
        assert db.get(Job, job_id).state == "QUEUED"
        assert db.get(Outbox, job_id).last_sent_at is None
    published = []
    dispatch_once(publish=published.append)
    assert job_id in published


def test_republish_after_previously_published_message_is_lost(clients, photo):
    client, _ = clients()
    accepted = accept(client, upload(client, photo))
    job_id = uuid.UUID(accepted["job_id"])
    with session_factory()() as db, db.begin():
        db.get(Outbox, job_id).last_sent_at = now() - timedelta(minutes=1)
    published = []
    dispatch_once(publish=published.append)
    assert job_id in published


def test_process_without_client_and_replay_is_noop(clients, photo):
    client, _ = clients()
    accepted = accept(client, upload(client, photo))
    client.close()
    process_job(accepted["job_id"])
    process_job(accepted["job_id"])
    with session_factory()() as db:
        job = db.get(Job, uuid.UUID(accepted["job_id"]))
        scan = db.get(Scan, job.scan_id)
        assert job.state == "SUCCEEDED" and job.attempts == 1
        assert scan.state == "PHOTO_READY"
        assert (scan.width, scan.height) == (20, 40)
        assert job.result["cards_added"] == 0
        assert job.result["recognition_available"] is True
        obj = storage.get(scan.prepared_key)
        image = Image.open(io.BytesIO(obj["Body"].read()))
        assert not image.getexif()
        obj["Body"].close()


def test_cross_owner_reads_and_finalize_rejected(clients, photo):
    owner, _ = clients()
    stranger, _ = clients()
    scan_id = upload(owner, photo)
    process_job(accept(owner, scan_id)["job_id"])
    assert stranger.get(f"/api/v1/scans/{scan_id}").status_code == 404
    assert stranger.get(f"/api/v1/scans/{scan_id}/image").status_code == 404
    assert stranger.get("/api/v1/scans").json()["items"] == []
    assert (
        stranger.post(
            f"/api/v1/scans/{scan_id}/finalize", headers={"Idempotency-Key": "stranger-finalize"}
        ).status_code
        == 404
    )
    assert owner.get(f"/api/v1/scans/{scan_id}/image").status_code == 200


def test_old_attempt_cannot_overwrite_new_lease(clients, photo):
    client, _ = clients()
    job_id = uuid.UUID(accept(client, upload(client, photo))["job_id"])
    old = claim(job_id)
    with session_factory()() as db, db.begin():
        db.get(Job, job_id).lease_until = now() - timedelta(seconds=1)
    reconcile()
    new = claim(job_id)
    assert new["token"] != old["token"]
    assert not finish(
        old, {"prepared_key": "stale", "thumbnail_key": "stale", "width": 1, "height": 1}
    )
    with session_factory()() as db:
        assert db.get(Job, job_id).state == "RUNNING"
        assert db.get(Scan, old["scan_id"]).prepared_key is None


def test_deadline_is_terminal_and_actionable(clients, photo):
    client, _ = clients()
    accepted = accept(client, upload(client, photo))
    with session_factory()() as db, db.begin():
        db.get(Job, uuid.UUID(accepted["job_id"])).deadline_at = now() - timedelta(seconds=1)
    reconcile()
    result = client.get("/api/v1/scans/" + accepted["scan_id"]).json()
    assert result["state"] == "FAILED"
    assert result["job"]["error_message"]


def test_corrupt_image_fails_after_acceptance_without_fake_recognition(clients):
    client, _ = clients()
    accepted = accept(client, upload(client, b"\xff\xd8\xff" + b"invalid still photo"))
    process_job(accepted["job_id"])
    scan = client.get("/api/v1/scans/" + accepted["scan_id"]).json()
    assert scan["state"] == "FAILED"
    assert scan["job"]["error_code"] == "INVALID_IMAGE"
    assert scan["job"]["result"] is None


def test_same_photo_warning_is_owner_scoped(clients, photo):
    client, _ = clients()
    stranger, _ = clients()
    first = upload(client, photo)
    second = upload(client, photo)
    other = upload(stranger, photo)
    assert client.get("/api/v1/scans/" + second).json()["duplicate_scan_id"] == first
    assert stranger.get("/api/v1/scans/" + other).json()["duplicate_scan_id"] is None


def test_oversized_decode_is_rejected(photo, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_decoded_pixels", 100)
    with pytest.raises(ImageRejected):
        prepare_image(photo)


def test_animated_images_rejected():
    stream = io.BytesIO()
    image = Image.new("RGB", (10, 10), "red")
    image.save(stream, "PNG", save_all=True, append_images=[Image.new("RGB", (10, 10), "blue")])
    with pytest.raises(ImageRejected):
        prepare_image(stream.getvalue())


def test_retention_deletes_photo_but_keeps_history(clients, photo):
    client, _ = clients()
    accepted = accept(client, upload(client, photo))
    process_job(accepted["job_id"])
    with session_factory()() as db, db.begin():
        db.get(Scan, uuid.UUID(accepted["scan_id"])).expires_at = now() - timedelta(seconds=1)
    cleanup()
    scan = client.get("/api/v1/scans/" + accepted["scan_id"]).json()
    assert scan["state"] == "EXPIRED"
    assert scan["filename"] == "pack.jpg"
    assert client.get("/api/v1/scans/" + accepted["scan_id"] + "/image").status_code == 404


def test_retention_protects_accepted_work(clients, photo):
    client, _ = clients()
    accepted = accept(client, upload(client, photo))
    with session_factory()() as db, db.begin():
        db.get(Scan, uuid.UUID(accepted["scan_id"])).expires_at = now() - timedelta(seconds=1)
    cleanup()
    with session_factory()() as db:
        scan = db.get(Scan, uuid.UUID(accepted["scan_id"]))
        assert scan.source_key is not None and scan.state == "QUEUED"
