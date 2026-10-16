import secrets
import uuid

import pytest
from sqlalchemy import delete, select

from scanner import transfers
from scanner.db import session_factory
from scanner.models import CatalogSnapshot, ImportRow, Job, Printing
from scanner.worker import process_job

NAME = "Synthetic Cancel Fixture"
LIST = "\n".join(f"{n} {NAME} (icx) {1 + n % 2}" for n in range(1, 8)).encode()


@pytest.fixture(scope="module")
def catalog(isolated_database):
    """Two printings of one made-up card in a set no other test uses."""
    ids = [uuid.uuid4(), uuid.uuid4()]
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic import cancel fixture, not real card data",
            checksum=secrets.token_hex(32),
            printings=2,
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        for index, identifier in enumerate(ids):
            db.add(
                Printing(
                    id=identifier,
                    name=NAME,
                    set_code="icx",
                    collector_number=str(index + 1),
                    language="en",
                    finishes=["nonfoil", "foil"],
                    snapshot_id=snapshot_id,
                    source_json={},
                )
            )
    yield ids
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_(ids)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def key():
    return {"Idempotency-Key": secrets.token_hex(16)}


def upload(client, data=LIST, filename="cards.txt"):
    response = client.post(
        "/api/v1/imports", params={"filename": filename}, content=data, headers=key()
    )
    assert response.status_code == 202, response.text
    return response.json()


def job_for(batch, kind):
    return next(item for item in batch["jobs"] if item["kind"] == kind)


def run(client, batch, kind):
    process_job(job_for(batch, kind)["id"])
    return client.get("/api/v1/imports/" + batch["id"]).json()


def small_tasks(monkeypatch):
    """Make every task hand off after one tiny chunk, as a slow server would."""
    monkeypatch.setattr(transfers, "TASK_BUDGET_SECONDS", 0)
    monkeypatch.setattr(transfers, "CHUNK_ROWS", 2)


def test_long_preview_continues_instead_of_starting_over(clients, catalog, monkeypatch):
    client, _ = clients()
    small_tasks(monkeypatch)
    batch = upload(client)
    batch = run(client, batch, "IMPORT_PREVIEW")
    assert batch["state"] == "PREVIEWING"
    job = job_for(batch, "IMPORT_PREVIEW")
    assert job["state"] == "QUEUED"
    assert job["progress"]["done"] == 2 and job["progress"]["total"] == 7
    runs = 1
    while batch["state"] == "PREVIEWING":
        batch = run(client, batch, "IMPORT_PREVIEW")
        runs += 1
        assert runs < 10
    assert runs == 4
    assert batch["state"] == "REVIEW", batch
    assert batch["summary"]["rows"] == 7 and batch["summary"]["ready_copies"] == 28
    assert "preview_rows_revision" not in batch["options"]
    with session_factory()() as db:
        job = db.get(Job, uuid.UUID(job_for(batch, "IMPORT_PREVIEW")["id"]))
        assert job.state == "SUCCEEDED" and job.attempts == 1
        numbers = db.scalars(
            select(ImportRow.row_number).where(ImportRow.import_id == uuid.UUID(batch["id"]))
        ).all()
    assert sorted(numbers) == list(range(2, 9))


def test_long_commit_continues_until_every_copy_is_added(clients, catalog, monkeypatch):
    client, _ = clients()
    batch = run(client, upload(client), "IMPORT_PREVIEW")
    small_tasks(monkeypatch)
    response = client.post(
        "/api/v1/imports/" + batch["id"] + "/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers=key(),
    )
    batch = response.json()
    runs = 0
    while batch["state"] == "COMMITTING":
        batch = run(client, batch, "IMPORT_COMMIT")
        runs += 1
        assert runs < 10
    assert batch["state"] == "COMPLETED", batch
    assert client.get("/api/v1/collection").json()["copies"] == 28


def test_cancel_stops_a_preview_and_frees_the_file(clients, catalog, monkeypatch):
    client, _ = clients()
    small_tasks(monkeypatch)
    batch = run(client, upload(client), "IMPORT_PREVIEW")
    assert batch["state"] == "PREVIEWING"
    cancelled = client.post(f"/api/v1/imports/{batch['id']}/cancel", headers=key())
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["state"] == "CANCELLED"
    assert job_for(cancelled.json(), "IMPORT_PREVIEW")["state"] == "FAILED"
    # A task already handed to the worker finds nothing left to do.
    after = run(client, batch, "IMPORT_PREVIEW")
    assert after["state"] == "CANCELLED"
    with session_factory()() as db:
        rows = db.scalars(
            select(ImportRow).where(ImportRow.import_id == uuid.UUID(batch["id"]))
        ).all()
    assert len(rows) == 2
    assert client.get("/api/v1/collection").json()["copies"] == 0
    # Cancelling twice is harmless, and the same file can be chosen again.
    assert client.post(f"/api/v1/imports/{batch['id']}/cancel", headers=key()).status_code == 200
    again = upload(client)
    assert again["id"] != batch["id"]


def test_only_a_preview_in_progress_can_be_cancelled(clients, catalog):
    client, _ = clients()
    batch = run(client, upload(client, filename="ready.txt"), "IMPORT_PREVIEW")
    assert batch["state"] == "REVIEW"
    response = client.post(f"/api/v1/imports/{batch['id']}/cancel", headers=key())
    assert response.status_code == 409
    other, _ = clients()
    assert other.post(f"/api/v1/imports/{batch['id']}/cancel", headers=key()).status_code == 404


def test_cancelled_imports_do_not_count_as_running(clients, catalog):
    client, _ = clients()
    for name in ("one.txt", "two.txt"):
        batch = upload(client, LIST + name.encode(), name)
        client.post(f"/api/v1/imports/{batch['id']}/cancel", headers=key())
    third = upload(client, LIST + f"\n1 {NAME} (icx) 1".encode(), "three.txt")
    assert third["state"] == "PREVIEWING"


def test_name_without_a_set_reports_ambiguity(clients, catalog):
    client, _ = clients()
    batch = run(client, upload(client, f"2 {NAME}".encode(), "names.txt"), "IMPORT_PREVIEW")
    assert batch["state"] == "REVIEW"
    assert batch["summary"]["unresolved_rows"] == 1
    rows = client.get(f"/api/v1/imports/{batch['id']}/rows").json()["items"]
    assert "ambiguous" in rows[0]["error"]
