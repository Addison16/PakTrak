import csv
import gzip
import io
import json
import secrets
import uuid
from datetime import timedelta

import pytest
from conftest import accept, upload
from PIL import Image, ImageDraw
from sqlalchemy import delete, select

from scanner import storage, transfers
from scanner.catalog import import_file
from scanner.csv_formats import normalize, safe_cell
from scanner.db import session_factory
from scanner.detection import detect_regions
from scanner.maintenance import cleanup
from scanner.models import (
    CatalogSnapshot,
    ExportBatch,
    ImportBatch,
    InventoryLot,
    Job,
    LoginSession,
    Printing,
    now,
)
from scanner.worker import process_job


@pytest.fixture(scope="session")
def catalog(isolated_database):
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic integration fixture, not real card data",
            checksum=secrets.token_hex(32),
            printings=2,
        )
        db.add(snapshot)
        db.flush()
        ids = [uuid.uuid4(), uuid.uuid4()]
        for index, identifier in enumerate(ids):
            db.add(
                Printing(
                    id=identifier,
                    name="Synthetic Fixture Card",
                    set_code="tst",
                    collector_number=str(index + 1),
                    language="en",
                    finishes=["nonfoil", "foil", "etched"],
                    snapshot_id=snapshot.id,
                    source_json={},
                )
            )
        snapshot_id = snapshot.id
    yield [str(value) for value in ids]
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_(ids)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def key():
    return {"Idempotency-Key": secrets.token_hex(16)}


def csv_bytes(rows):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def run_batch(client, batch, kind):
    job = next(item for item in batch["jobs"] if item["kind"] == kind)
    process_job(job["id"])
    return client.get("/api/v1/imports/" + batch["id"]).json()


def preview(client, rows=None, data=None, **params):
    response = client.post(
        "/api/v1/imports",
        params={"filename": "synthetic-collection.csv", **params},
        content=data or csv_bytes(rows),
        headers=key(),
    )
    assert response.status_code == 202, response.text
    return run_batch(client, response.json(), "IMPORT_PREVIEW")


def commit(client, batch, **options):
    response = client.post(
        "/api/v1/imports/" + batch["id"] + "/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True, **options},
        headers=key(),
    )
    assert response.status_code == 202, response.text
    result = run_batch(client, response.json(), "IMPORT_COMMIT")
    assert result["state"] == "COMPLETED", result
    return result


def export(client, format="canonical"):
    response = client.post("/api/v1/exports", json={"format": format}, headers=key())
    assert response.status_code == 202, response.text
    export_id = response.json()["id"]
    with session_factory()() as db:
        job_id = db.scalar(select(Job.id).where(Job.export_id == uuid.UUID(export_id)))
    process_job(str(job_id))
    value = client.get("/api/v1/exports/" + export_id).json()
    assert value["state"] == "READY", value
    return value


def test_canonical_roundtrip_preserves_copies_unknowns_binders_and_extensions(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    rows = [
        {
            "Scryfall ID": catalog[0],
            "Quantity": str(quantity),
            "Notes": note,
            "Binder Name": "'Binder, Ω",
            "Purchase Price": "1.2300",
            "Purchase Price Currency": "usd",
            "Extra field": "Preserve this",
        }
        for quantity, note in [(2, '=SUM(1,2)\nΩ quoted, "text"'), (3, "'already an apostrophe")]
    ]
    batch = preview(client, rows)
    assert batch["state"] == "REVIEW", batch
    assert batch["summary"]["ready_copies"] == 5
    assert client.get("/api/v1/collection").json()["copies"] == 0
    commit(client, batch)
    saved = client.get("/api/v1/collection").json()
    assert saved["copies"] == 5
    assert len(saved["items"]) == 2  # Physical copies are not deduplicated by printing.
    assert {item["finish"] for item in saved["items"]} == {"unknown"}
    assert {item["condition"] for item in saved["items"]} == {"ungraded"}
    downloaded = export(client)
    data = client.get(downloaded["download_url"]).content
    records = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
    assert any(row["notes"].startswith("'=SUM") for row in records)
    imported = preview(other, data=data)
    assert imported["state"] == "REVIEW", imported
    commit(other, imported)
    second = export(other)
    roundtrip = list(
        csv.DictReader(io.StringIO(other.get(second["download_url"]).content.decode("utf-8-sig")))
    )
    assert sorted(records, key=lambda row: row["quantity"]) == sorted(
        roundtrip, key=lambda row: row["quantity"]
    )


def test_unknown_conflicting_and_wishlist_rows_never_silently_add(clients, catalog):
    client, _ = clients()
    base = {
        "Scryfall ID": catalog[0],
        "Quantity": "1",
        "Set Code": "tst",
        "Binder Type": "binder",
        "Foil": "",
    }
    batch = preview(
        client,
        [
            base,
            {**base, "Scryfall ID": str(uuid.uuid4())},
            {**base, "Set Code": "wrong"},
            {**base, "Binder Type": "list"},
            {**base, "Foil": "glitter"},
        ],
    )
    states = batch["summary"]["states"]
    assert states["READY"]["copies"] == 1
    assert states["UNRESOLVED"]["rows"] == 2
    assert states["SKIPPED"]["rows"] == 1
    assert states["INVALID"]["rows"] == 1
    response = client.post(
        f"/api/v1/imports/{batch['id']}/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers=key(),
    )
    assert response.status_code == 422
    commit(client, batch, accept_partial=True)
    assert client.get("/api/v1/collection").json()["copies"] == 1
    assert (
        len(
            list(
                csv.DictReader(
                    io.StringIO(
                        client.get(f"/api/v1/imports/{batch['id']}/unresolved.csv").content.decode(
                            "utf-8-sig"
                        )
                    )
                )
            )
        )
        == 4
    )


def test_mapping_explicit_quantity_and_stale_preview(clients, catalog):
    client, _ = clients()
    batch = preview(client, [{"Card reference": catalog[0], "Where": "My binder"}])
    assert batch["summary"]["ready_copies"] == 0
    response = client.post(
        f"/api/v1/imports/{batch['id']}/preview",
        json={
            "expected_revision": batch["revision"],
            "mapping": {"scryfall_id": "Card reference", "binder": "Where"},
            "options": {"default_quantity": 1},
        },
        headers=key(),
    )
    assert response.status_code == 202, response.text
    revised = run_batch(client, response.json(), "IMPORT_PREVIEW")
    assert revised["summary"]["ready_copies"] == 1
    response = client.post(
        f"/api/v1/imports/{batch['id']}/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers=key(),
    )
    assert response.status_code == 409
    commit(client, revised)
    assert client.get("/api/v1/collection").json()["items"][0]["binder"] == "My binder"


def test_duplicate_upload_and_confirmation_retries_are_safe(clients, catalog):
    client, _ = clients()
    data = csv_bytes([{"Scryfall ID": catalog[0], "Quantity": "2"}])
    headers = key()
    responses = [
        client.post("/api/v1/imports?filename=fixture.csv", content=data, headers=headers)
        for _ in range(2)
    ]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    duplicate = client.post("/api/v1/imports?filename=fixture.csv", content=data, headers=key())
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["existing_import_id"] == responses[0].json()["id"]
    changed = client.post("/api/v1/imports?filename=other.csv", content=data, headers=headers)
    assert changed.status_code == 409
    batch = run_batch(client, responses[0].json(), "IMPORT_PREVIEW")
    headers = key()
    body = {"expected_revision": batch["revision"], "owned_cards": True}
    first = client.post(f"/api/v1/imports/{batch['id']}/confirm", json=body, headers=headers)
    assert first.status_code == 202
    run_batch(client, first.json(), "IMPORT_COMMIT")
    again = client.post(f"/api/v1/imports/{batch['id']}/confirm", json=body, headers=headers)
    assert again.status_code == 202
    run_batch(client, again.json(), "IMPORT_COMMIT")
    assert client.get("/api/v1/collection").json()["copies"] == 2


def test_partial_worker_failure_replays_only_remaining_rows(clients, catalog, monkeypatch):
    client, _ = clients()
    batch = preview(client, [{"Scryfall ID": catalog[0], "Quantity": "1"}] * 105)
    response = client.post(
        f"/api/v1/imports/{batch['id']}/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers=key(),
    )
    original = transfers.add_lot
    added = 0

    def interrupted(*args, **kwargs):
        nonlocal added
        added += 1
        if added == 101:
            raise RuntimeError("Injected worker failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(transfers, "add_lot", interrupted)
    partial = run_batch(client, response.json(), "IMPORT_COMMIT")
    assert partial["summary"]["committed_copies"] == 100
    monkeypatch.setattr(transfers, "add_lot", original)
    completed = run_batch(client, partial, "IMPORT_COMMIT")
    assert completed["state"] == "COMPLETED"
    assert client.get("/api/v1/collection").json()["copies"] == 105


def test_undo_barrier_stops_queued_commit_and_preserves_other_holdings(clients, catalog):
    client, _ = clients()
    unrelated = commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    assert unrelated["state"] == "COMPLETED"
    batch = preview(client, [{"Scryfall ID": catalog[0], "Quantity": "9"}])
    queued = client.post(
        f"/api/v1/imports/{batch['id']}/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers=key(),
    ).json()
    undo = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        json={"expected_revision": queued["revision"]},
        headers=key(),
    )
    assert undo.status_code == 202
    run_batch(client, queued, "IMPORT_COMMIT")
    result = run_batch(client, undo.json(), "IMPORT_UNDO")
    assert result["state"] == "UNDONE"
    assert client.get("/api/v1/collection").json()["copies"] == 2


def test_undo_only_remaining_quantities_after_removal(clients, catalog):
    client, _ = clients()
    batch = commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "7"}]))
    lot = client.get("/api/v1/collection").json()["items"][0]
    response = client.post(
        f"/api/v1/collection/{lot['id']}/quantity",
        json={"expected_version": lot["version"], "quantity": 4},
        headers=key(),
    )
    assert response.status_code == 200
    queued = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        json={"expected_revision": batch["revision"]},
        headers=key(),
    ).json()
    result = run_batch(client, queued, "IMPORT_UNDO")
    run_batch(client, result, "IMPORT_UNDO")
    assert result["summary"]["undone_copies"] == 4
    assert result["summary"]["previously_removed_copies"] == 3
    assert client.get("/api/v1/collection").json()["copies"] == 0


def test_transfer_ownership_csrf_and_export_expiry(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    batch = commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "1"}]))
    result = export(client)
    for route in [
        f"imports/{batch['id']}",
        f"imports/{batch['id']}/rows",
        f"imports/{batch['id']}/unresolved.csv",
        f"exports/{result['id']}",
        f"exports/{result['id']}/download",
    ]:
        assert other.get("/api/v1/" + route).status_code == 404
    assert (
        other.post(
            f"/api/v1/imports/{batch['id']}/undo",
            json={"expected_revision": batch["revision"]},
            headers=key(),
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/v1/exports", json={}, headers={**key(), "X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/exports", json={"owner_id": str(uuid.uuid4())}, headers=key()
        ).status_code
        == 422
    )
    with session_factory()() as db, db.begin():
        db.get(ExportBatch, uuid.UUID(result["id"])).expires_at = now() - timedelta(seconds=1)
    assert client.get(result["download_url"]).status_code == 404
    cleanup()
    assert client.get(f"/api/v1/exports/{result['id']}").json()["state"] == "EXPIRED"


def test_portable_csv_keeps_unknown_finish_and_condition_without_excluding_cards(clients, catalog):
    client, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "3"}]))
    result = export(client, "csv")
    assert result["report"]["excluded_copies"] == 0
    assert not result["requires_acknowledgment"]
    assert client.get(result["download_url"]).status_code == 200
    assert (
        len(
            list(
                csv.DictReader(
                    io.StringIO(client.get(result["download_url"]).content.decode("utf-8-sig"))
                )
            )
        )
        == 1
    )


def test_export_retry_keeps_original_snapshot_during_edits(clients, catalog, monkeypatch):
    client, _ = clients()
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "5"}]))
    result = client.post("/api/v1/exports", json={}, headers=key()).json()
    with session_factory()() as db:
        job_id = str(db.scalar(select(Job.id).where(Job.export_id == uuid.UUID(result["id"]))))
    original = storage.put

    def failed(*args, **kwargs):
        raise RuntimeError("Injected storage failure after snapshot")

    monkeypatch.setattr(storage, "put", failed)
    process_job(job_id)
    lot = client.get("/api/v1/collection").json()["items"][0]
    assert (
        client.post(
            f"/api/v1/collection/{lot['id']}/quantity",
            json={"expected_version": lot["version"], "quantity": 1},
            headers=key(),
        ).status_code
        == 200
    )
    monkeypatch.setattr(storage, "put", original)
    process_job(job_id)
    ready = client.get(f"/api/v1/exports/{result['id']}").json()
    assert ready["report"]["copies"] == 5
    records = list(
        csv.DictReader(io.StringIO(client.get(ready["download_url"]).content.decode("utf-8-sig")))
    )
    assert records[0]["quantity"] == "5"


def test_expired_session_does_not_cancel_confirmed_import(clients, catalog):
    client, owner_id = clients()
    batch = preview(client, [{"Scryfall ID": catalog[0], "Quantity": "4"}])
    result = client.post(
        f"/api/v1/imports/{batch['id']}/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers=key(),
    ).json()
    client.close()
    with session_factory()() as db, db.begin():
        for login in db.scalars(select(LoginSession).where(LoginSession.owner_id == owner_id)):
            login.expires_at = now() - timedelta(seconds=1)
    process_job(next(item["id"] for item in result["jobs"] if item["kind"] == "IMPORT_COMMIT"))
    with session_factory()() as db:
        assert db.get(ImportBatch, uuid.UUID(batch["id"])).state == "COMPLETED"
        assert (
            db.scalar(
                select(InventoryLot.quantity_remaining).where(InventoryLot.owner_id == owner_id)
            )
            == 4
        )


@pytest.mark.parametrize(
    "data", [b"A,A\n1,2\n", b"A,B\n1,2,3\n", b'A,B\n"unterminated,2\n', b"A\n\x00\n"]
)
def test_malformed_csv_fails_without_holdings(clients, data):
    client, _ = clients()
    batch = preview(client, data=data)
    assert batch["state"] == "FAILED"
    assert batch["error"]
    assert client.get("/api/v1/collection").json()["copies"] == 0


@pytest.mark.parametrize(
    "note", ["=2+2", " +formula", "\t@formula", "'original", "normal\ntext", 'Ω comma, quotes"']
)
def test_canonical_formula_escape_is_reversible(note):
    raw = {
        "schema_version": "1",
        "cell_encoding": "apostrophe-v1",
        "quantity": "1",
        "notes": safe_cell(note),
    }
    assert (
        normalize(raw, {"quantity": "quantity", "notes": "notes"}, {}, "canonical")["notes"] == note
    )


def geometry_photo():
    canvas = Image.new("RGB", (1000, 700), "#334533")
    draw = ImageDraw.Draw(canvas)
    for x in (120, 560):
        draw.rectangle((x, 120, x + 180, 372), fill="#eeeecc", outline="black", width=5)
        draw.rectangle((x + 20, 170, x + 160, 270), fill="#775599")
    output = io.BytesIO()
    canvas.save(output, "JPEG")
    return output.getvalue()


def test_geometry_baseline_detects_two_distinct_synthetic_regions():
    # Geometry plumbing only; this does not qualify detection on photographs.
    regions = detect_regions(geometry_photo())
    assert len(regions) == 2
    assert abs(regions[0]["polygon"][0][0] - regions[1]["polygon"][0][0]) > 0.3
    for region in regions:
        assert Image.open(io.BytesIO(region["crop"])).size == (600, 840)


def test_manual_review_retries_add_one_copy_and_two_regions_remain_distinct(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    scan_id = upload(client, geometry_photo())
    accepted = accept(client, scan_id)
    process_job(accepted["job_id"])
    regions = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert len(regions) == 2
    assert other.get(regions[0]["crop_url"]).status_code == 404
    for region in regions:
        body = {"expected_version": region["version"], "action": "add", "printing_id": catalog[0]}
        for _ in range(2):
            response = client.post(
                f"/api/v1/scans/{scan_id}/observations/{region['id']}/decision",
                json=body,
                headers=key(),
            )
            assert response.status_code == 200, response.text
    process_job(accepted["job_id"])
    assert client.get("/api/v1/collection").json()["copies"] == 2
    grouped = client.get("/api/v1/collection/cards").json()
    assert grouped["cards"] == 1
    assert grouped["items"][0]["quantity"] == 2
    # Additional physical copies join the same displayed count; source-specific
    # undo and scan retries must still preserve the independently scanned cards.
    batch = commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "3"}]))
    assert client.get("/api/v1/collection/cards").json()["items"][0]["quantity"] == 5
    undo = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        json={"expected_revision": batch["revision"]},
        headers=key(),
    )
    assert undo.status_code == 202
    run_batch(client, undo.json(), "IMPORT_UNDO")
    assert client.get("/api/v1/collection/cards").json()["items"][0]["quantity"] == 2


def test_catalog_import_is_atomic_and_retains_previous_printings(tmp_path):
    card_id = uuid.uuid4()
    card = {
        "id": str(card_id),
        "name": "Synthetic Atomicity Fixture",
        "set": "tst",
        "collector_number": "A-1",
        "lang": "en",
        "finishes": ["nonfoil"],
        "games": ["paper"],
    }
    path = tmp_path / "synthetic-catalog.json"
    path.write_text(json.dumps([card]))
    assert import_file(path, "synthetic test fixture") == 1
    assert import_file(path, "synthetic test fixture") == 1
    path.write_text(json.dumps([{**card, "name": "Should roll back"}, {"id": "invalid"}]))
    with pytest.raises(ValueError):
        import_file(path, "invalid fixture")
    with session_factory()() as db, db.begin():
        printing = db.get(Printing, card_id)
        assert printing.name == card["name"]
        snapshot_id = printing.snapshot_id
        db.delete(printing)
        db.flush()
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def test_current_scryfall_gzipped_json_lines(tmp_path):
    card_id = uuid.uuid4()
    card = {
        "id": str(card_id),
        "name": "Synthetic JSON Lines Fixture",
        "set": "tst",
        "collector_number": "1",
        "lang": "en",
        "finishes": [],
        "games": ["paper"],
    }
    path = tmp_path / "synthetic.jsonl.gz"
    with gzip.open(path, "wt") as handle:
        handle.write(json.dumps(card) + "\n")
    assert import_file(path, "synthetic gzip fixture") == 1
    with session_factory()() as db, db.begin():
        printing = db.get(Printing, card_id)
        assert printing.finishes == []  # Missing provider metadata is not invented.
        snapshot_id = printing.snapshot_id
        db.delete(printing)
        db.flush()
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def test_failed_undo_cannot_reopen_import_for_additions(clients, catalog):
    client, _ = clients()
    batch = commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    response = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        json={"expected_revision": batch["revision"]},
        headers=key(),
    )
    assert response.status_code == 202
    with session_factory()() as db, db.begin():
        resource = db.get(ImportBatch, uuid.UUID(batch["id"]))
        resource.state = "FAILED"  # Even a failed undo retains its durable cancellation barrier.
        commit_key = resource.options["commit_request"][0]
    response = client.post(
        f"/api/v1/imports/{batch['id']}/confirm",
        json={"expected_revision": batch["revision"], "owned_cards": True},
        headers={"Idempotency-Key": commit_key},
    )
    assert response.status_code == 409
