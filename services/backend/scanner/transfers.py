"""Durable collection transfers and inventory effects, independent of browser sessions."""

import csv
import hashlib
import io
import tempfile
import uuid
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from scanner import csv_formats as formats
from scanner import storage
from scanner.db import session_factory
from scanner.models import (
    Binder,
    ExportBatch,
    ExportRow,
    ImportBatch,
    ImportRow,
    InventoryEvent,
    InventoryLot,
    Job,
    Outbox,
    Printing,
    WorkProgress,
    now,
)
from scanner.progress import job_progress


class TransferRejected(Exception):
    pass


def enqueue(db, kind, *, import_id=None, export_id=None):
    job = (
        db.scalar(select(Job).where(Job.import_id == import_id, Job.kind == kind))
        if import_id
        else None
    )
    if job:
        if job.state in {"QUEUED", "RUNNING"}:
            return job
        job.state, job.attempts = "QUEUED", 0
        job.stage, job.error_code, job.error_message, job.result = (
            "Waiting for a server worker",
            None,
            None,
            None,
        )
        job.completed_at = job.lease_token = job.lease_until = None
        job.deadline_at = now() + timedelta(hours=24)
        outbox = db.get(Outbox, job.id)
        outbox.available_at, outbox.last_sent_at = now(), None
    else:
        job = Job(
            kind=kind,
            import_id=import_id,
            export_id=export_id,
            deadline_at=now() + timedelta(hours=24),
        )
        db.add(job)
        db.flush()
        db.add(Outbox(job_id=job.id))
    progress = db.get(WorkProgress, job.id)
    if progress:
        progress.token, progress.data = None, {}
    else:
        db.add(WorkProgress(job_id=job.id))
    return job


def get_binder(db, owner_id, name):
    # Concurrent scan review/imports can create the same destination safely.
    return db.execute(
        insert(Binder)
        .values(owner_id=owner_id, name=name)
        .on_conflict_do_update(index_elements=["owner_id", "name"], set_={"name": name})
        .returning(Binder.id)
    ).scalar_one()


def add_lot(db, owner_id, printing_id, values, *, import_row_id=None, observation_id=None):
    lot = InventoryLot(
        owner_id=owner_id,
        printing_id=printing_id,
        binder_id=get_binder(db, owner_id, values["binder"]),
        quantity_remaining=values["quantity"],
        finish=values["finish"],
        condition=values["condition"],
        notes=values.get("notes", ""),
        purchase_price=Decimal(values["purchase_price"])
        if values.get("purchase_price") is not None
        else None,
        purchase_currency=values.get("purchase_currency"),
        misprint=values.get("misprint"),
        altered=values.get("altered"),
        source_metadata=values.get("source_metadata", {}),
        source_import_row_id=import_row_id,
        source_observation_id=observation_id,
    )
    db.add(lot)
    db.flush()
    db.add(
        InventoryEvent(
            lot_id=lot.id,
            kind="ADD_IMPORT" if import_row_id else "ADD_REVIEW",
            delta=lot.quantity_remaining,
            operation_key=f"add:{import_row_id or observation_id}",
            detail={
                "printing_id": str(printing_id),
                "finish": lot.finish,
                "condition": lot.condition,
            },
        )
    )
    return lot


def summary(db, batch):
    counts = db.execute(
        select(ImportRow.state, func.count(), func.coalesce(func.sum(ImportRow.quantity), 0))
        .where(ImportRow.import_id == batch.id)
        .group_by(ImportRow.state)
    ).all()
    states = {state: {"rows": rows, "copies": copies} for state, rows, copies in counts}
    return {
        "rows": sum(row[1] for row in counts),
        "states": states,
        "ready_copies": states.get("READY", {}).get("copies", 0),
        "committed_copies": states.get("COMMITTED", {}).get("copies", 0),
        "unresolved_rows": sum(
            states.get(state, {}).get("rows", 0) for state in ("UNRESOLVED", "INVALID")
        ),
    }


def active(db, claimed):
    job = db.scalar(select(Job).where(Job.id == claimed["id"]).with_for_update())
    if not job or job.state != "RUNNING" or job.lease_token != claimed["token"]:
        return None
    return job


def complete(job, message):
    job.state, job.stage, job.completed_at = "SUCCEEDED", message, now()
    job.lease_token = job.lease_until = None


def preview(claimed):
    progress = job_progress(claimed)
    progress("Reading saved file", force=True)
    with session_factory()() as db:
        batch = db.get(ImportBatch, claimed["import_id"])
        if batch.state != "PREVIEWING":
            return
        source_key, options, mapping, fmt, revision = (
            batch.source_key,
            batch.options,
            batch.mapping,
            batch.format,
            batch.revision,
        )
        checksum = batch.checksum
        filename = batch.filename
        if not source_key:
            raise TransferRejected("The raw file expired. Upload it again to change its mapping.")
    obj = storage.get(source_key)
    try:
        data = obj["Body"].read(formats.MAX_BYTES + 1)
    finally:
        obj["Body"].close()
    if hashlib.sha256(data).hexdigest() != checksum:
        raise TransferRejected("Stored CSV verification failed. Upload the file again.")
    try:
        if fmt == "text" or (fmt == "auto" and filename.lower().endswith(".txt")):
            fmt = "text"
            options = {
                **options,
                "text_default_finish": options.get("text_default_finish", "nonfoil"),
            }
            headers, raw_rows, delimiter = formats.read_text(data, options)
        else:
            headers, raw_rows, delimiter = formats.read_csv(data, options)
        if fmt == "manabox":  # Old persisted previews keep their generic column mappings.
            fmt = "generic"
        fmt, guessed = formats.infer_mapping(headers, fmt)
        mapping = mapping or guessed
        if any(column not in headers for column in mapping.values()):
            raise ValueError("A mapped column is absent from this file.")
        with session_factory()() as db, db.begin():
            job = active(db, claimed)
            if not job:
                return
            batch = db.scalar(
                select(ImportBatch).where(ImportBatch.id == claimed["import_id"]).with_for_update()
            )
            if batch.state != "PREVIEWING" or batch.revision != revision:
                return
            db.execute(delete(ImportRow).where(ImportRow.import_id == batch.id))
            progress("Matching card rows", 0, len(raw_rows), force=True)
            for index, raw in enumerate(raw_rows, start=2):
                normalized, printing, error, state = {}, None, None, "INVALID"
                try:
                    normalized = formats.normalize(raw, mapping, options, fmt)
                    if normalized["binder_type"] in {"list", "wishlist", "wish list", "deck"}:
                        state, error = (
                            "SKIPPED",
                            "Non-owned list excluded. No copies will be added.",
                        )
                    elif normalized["binder_type"] not in {"", "binder", "collection"}:
                        state, error = (
                            "UNRESOLVED",
                            "Unknown binder/list type. Confirm these are owned cards.",
                        )
                    else:
                        printing, error = formats.resolve(db, normalized)
                        state = "READY" if printing else "UNRESOLVED"
                except ValueError as exc:
                    error = str(exc)
                db.add(
                    ImportRow(
                        id=uuid.uuid5(batch.id, str(index)),
                        import_id=batch.id,
                        row_number=index,
                        raw_fields=raw,
                        normalized=normalized,
                        printing_id=printing.id if printing else None,
                        quantity=normalized.get("quantity"),
                        state=state,
                        error=error,
                    )
                )
                if index % 50 == 0:
                    progress("Matching card rows", index - 1, len(raw_rows))
            batch.format, batch.mapping, batch.headers = fmt, mapping, headers
            batch.options = {**options, "delimiter": delimiter}
            batch.state, batch.error = "REVIEW", None
            batch.expires_at = now() + timedelta(days=7)
            db.flush()
            batch.summary = summary(db, batch)
            complete(job, "File preview saved; review before adding copies")
            progress("Preview ready", len(raw_rows), len(raw_rows), force=True)
    except ValueError as exc:
        raise TransferRejected(str(exc)) from exc


def commit_import(claimed):
    progress = job_progress(claimed)
    done, total = 0, None
    while True:
        with session_factory()() as db, db.begin():
            job = active(db, claimed)
            if not job:
                return
            batch = db.scalar(
                select(ImportBatch).where(ImportBatch.id == claimed["import_id"]).with_for_update()
            )
            if batch.state != "COMMITTING" or batch.options.get("undo_requested"):
                complete(job, "Import stopped by an undo request")
                return
            if total is None:
                total = db.scalar(
                    select(func.count())
                    .select_from(ImportRow)
                    .where(ImportRow.import_id == batch.id, ImportRow.state == "READY")
                )
                progress("Adding card rows", 0, total, force=True)
            rows = db.scalars(
                select(ImportRow)
                .where(ImportRow.import_id == batch.id, ImportRow.state == "READY")
                .order_by(ImportRow.row_number)
                .limit(100)
                .with_for_update()
            ).all()
            if not rows:
                batch.state = "COMPLETED"
                batch.summary = summary(db, batch)
                batch.expires_at = now() + timedelta(days=7)
                complete(job, "Selected collection rows added")
                progress("Import complete", done, total, force=True)
                return
            for row in rows:
                existing = db.scalar(
                    select(InventoryLot.id).where(
                        InventoryLot.source_import_row_id == row.id,
                        InventoryLot.split_parent_id.is_(None),
                    )
                )
                if not existing:
                    add_lot(
                        db, batch.owner_id, row.printing_id, row.normalized, import_row_id=row.id
                    )
                row.state = "COMMITTED"
            db.flush()
            batch.summary = summary(db, batch)
            job.stage = f"Added {batch.summary['committed_copies']} copies"
        done += len(rows)
        progress("Adding card rows", done, total)


def undo_import(claimed):
    while True:
        with session_factory()() as db, db.begin():
            job = active(db, claimed)
            if not job:
                return
            batch = db.scalar(
                select(ImportBatch).where(ImportBatch.id == claimed["import_id"]).with_for_update()
            )
            if batch.state != "UNDOING":
                complete(job, "Undo already handled")
                return
            lots = db.scalars(
                select(InventoryLot)
                .join(ImportRow, InventoryLot.source_import_row_id == ImportRow.id)
                .where(ImportRow.import_id == batch.id, InventoryLot.quantity_remaining > 0)
                .order_by(InventoryLot.id)
                .limit(100)
                .with_for_update(of=InventoryLot)
            ).all()
            if not lots:
                batch.state = "UNDONE"
                removed = db.scalar(
                    select(func.coalesce(func.sum(-InventoryEvent.delta), 0))
                    .join(InventoryLot)
                    .join(ImportRow, InventoryLot.source_import_row_id == ImportRow.id)
                    .where(ImportRow.import_id == batch.id, InventoryEvent.kind == "UNDO_IMPORT")
                )
                batch.summary = {
                    **summary(db, batch),
                    "undone_copies": removed,
                    "previously_removed_copies": max(
                        0, batch.summary.get("committed_copies", 0) - removed
                    ),
                }
                complete(job, "Remaining imported copies removed; unrelated holdings preserved")
                return
            for lot in lots:
                db.add(
                    InventoryEvent(
                        lot_id=lot.id,
                        operation_key=f"undo:{batch.id}:{lot.id}",
                        kind="UNDO_IMPORT",
                        delta=-lot.quantity_remaining,
                    )
                )
                lot.quantity_remaining = 0
                lot.version += 1


def export_collection(claimed):
    # Materialize an immutable logical snapshot before formatting. Retries reuse it.
    with session_factory()() as db:
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        snapshot_time = db.scalar(select(func.transaction_timestamp()))
        job = active(db, claimed)
        if not job:
            return
        export = db.scalar(
            select(ExportBatch).where(ExportBatch.id == claimed["export_id"]).with_for_update()
        )
        if export.snapshot_at is None:
            query = (
                select(InventoryLot, Printing, Binder)
                .join(Printing)
                .join(Binder, InventoryLot.binder_id == Binder.id)
                .where(
                    InventoryLot.owner_id == export.owner_id, InventoryLot.quantity_remaining > 0
                )
            )
            if export.binder_id:
                query = query.where(InventoryLot.binder_id == export.binder_id)
            count, copies, lost_metadata = 0, 0, 0
            for lot, printing, binder in db.execute(
                query.order_by(InventoryLot.id).execution_options(yield_per=500)
            ):
                count += 1
                if count > 50_000:
                    raise TransferRejected(
                        "Export exceeds 50,000 lots; export one binder at a time."
                    )
                payload = formats.canonical_row(lot, printing, binder)
                copies += lot.quantity_remaining
                if lot.source_metadata:
                    lost_metadata += lot.quantity_remaining
                db.add(ExportRow(export_id=export.id, lot_id=lot.id, payload=payload))
                if count % 500 == 0:
                    db.flush()
            export.snapshot_at = snapshot_time
            export.report = {
                "lots": count,
                "copies": copies,
                "excluded_copies": 0,
                "metadata_loss_copies": copies
                if export.format == "text"
                else lost_metadata
                if export.format in {"csv", "manabox"}
                else 0,
                "warnings": [
                    "Text lists omit locations, condition, language, notes and purchase details. Unmarked entries are normally read as nonfoil, so unknown finish is not preserved. Full CSV preserves all card details."
                ]
                if export.format == "text"
                else ["Extra source metadata is omitted. Use full CSV to keep it."]
                if export.format in {"csv", "manabox"} and lost_metadata
                else [],
            }
        export.state = "PROCESSING"
        db.commit()
        export_id, owner_id, fmt = export.id, export.owner_id, export.format
    with tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024) as spool:
        wrapper = io.TextIOWrapper(
            spool,
            encoding="utf-8" if fmt == "text" else "utf-8-sig",
            newline="",
            write_through=True,
        )
        columns = formats.CANONICAL if fmt == "canonical" else list(formats.PORTABLE_CSV)
        writer = csv.DictWriter(wrapper, fieldnames=columns)
        if fmt != "text":
            writer.writeheader()
        with session_factory()() as db:
            for row in db.scalars(
                select(ExportRow)
                .where(ExportRow.export_id == export_id)
                .order_by(ExportRow.lot_id)
                .execution_options(yield_per=500)
            ):
                payload = row.payload
                if fmt == "text":
                    wrapper.write(formats.text_line(payload) + "\n")
                    continue
                if fmt in {"csv", "manabox"}:
                    payload = {
                        target: payload[field] for target, field in formats.PORTABLE_CSV.items()
                    }
                    payload["Foil"] = {
                        "unknown": "",
                        "nonfoil": "normal",
                        "foil": "foil",
                        "etched": "etched",
                    }[payload["Foil"]]
                    payload["Condition"] = (
                        "" if payload["Condition"] == "ungraded" else payload["Condition"]
                    )
                writer.writerow(
                    {field: formats.safe_cell(value) for field, value in payload.items()}
                )
        wrapper.flush()
        wrapper.detach()
        spool.seek(0)
        checksum = hashlib.file_digest(spool, "sha256").hexdigest()
        spool.seek(0)
        key = (
            f"exports/{owner_id}/{export_id}/{claimed['token']}.{'txt' if fmt == 'text' else 'csv'}"
        )
        storage.put(key, spool, "text/plain" if fmt == "text" else "text/csv", checksum)
    with session_factory()() as db, db.begin():
        job = active(db, claimed)
        if not job:
            return
        export = db.get(ExportBatch, export_id)
        export.state, export.object_key, export.checksum = "READY", key, checksum
        export.expires_at = now() + timedelta(hours=24)
        complete(job, "Collection export saved")


def execute(claimed):
    {
        "IMPORT_PREVIEW": preview,
        "IMPORT_COMMIT": commit_import,
        "IMPORT_UNDO": undo_import,
        "EXPORT": export_collection,
    }[claimed["kind"]](claimed)
