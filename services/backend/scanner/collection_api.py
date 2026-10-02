import csv
import hashlib
import io
import json
import uuid
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from scanner import csv_formats as formats
from scanner import gallery, storage
from scanner.auth import DB, Identity
from scanner.card_search import card_name_matches, split_collector_search
from scanner.catalog import printing_json
from scanner.crop_orientation import display_rotation, oriented_crop
from scanner.models import (
    Binder,
    ExportBatch,
    ImportBatch,
    ImportRow,
    InventoryEvent,
    InventoryLot,
    Job,
    Observation,
    Printing,
    Scan,
    User,
    WorkProgress,
    now,
)
from scanner.transfers import add_lot, enqueue, summary

router = APIRouter(prefix="/api/v1", tags=["collection"])
Key = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=128)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Revision(StrictModel):
    expected_revision: int = Field(ge=1)


class ParseOptions(StrictModel):
    delimiter: Literal["auto", ",", ";", "\t"] = "auto"
    encoding: Literal["utf-8-sig", "utf-16"] = "utf-8-sig"
    default_quantity: int | None = Field(default=None, ge=1, le=100_000)
    default_language: str = Field(default="", max_length=16)
    default_binder: str = Field(default="Imported collection", min_length=1, max_length=255)
    text_default_finish: Literal["nonfoil", "unknown"] = "nonfoil"


class Preview(Revision):
    mapping: dict[str, str]
    options: ParseOptions


class Confirmation(Revision):
    owned_cards: Literal[True]
    accept_partial: bool = False


class RowRepair(Revision):
    printing_id: uuid.UUID | None = None
    skip: bool = False
    owned_cards: bool = False
    finish: Literal["unknown", "nonfoil", "foil", "etched"] = "unknown"


class ExportRequest(StrictModel):
    format: Literal["canonical", "csv", "text"] = "canonical"
    binder_id: uuid.UUID | None = None


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def owned(db, model, resource_id, owner_id, lock=False):
    query = select(model).where(model.id == resource_id, model.owner_id == owner_id)
    if model is Scan:
        query = query.where(Scan.deleted_at.is_(None))
    value = db.scalar(
        query.with_for_update().execution_options(populate_existing=True) if lock else query
    )
    if value is None:
        raise HTTPException(404, "Collection resource not found.")
    return value


def progress_for_job(db, job):
    progress = db.get(WorkProgress, job.id)
    return (
        progress.data
        if progress and progress.token == job.lease_token and job.state == "RUNNING"
        else None
    )


def import_json(db, batch):
    return {
        "id": str(batch.id),
        "filename": batch.filename,
        "format": "generic" if batch.format == "manabox" else batch.format,
        "state": batch.state,
        "revision": batch.revision,
        "mapping": batch.mapping,
        "options": batch.options,
        "headers": batch.headers,
        "summary": batch.summary,
        "error": batch.error,
        "created_at": batch.created_at,
        "raw_file_expires_at": batch.expires_at,
        "safe_to_disconnect": True,
        "jobs": [
            {
                "id": str(job.id),
                "kind": job.kind,
                "state": job.state,
                "stage": job.stage,
                "error": job.error_message,
                "progress": progress_for_job(db, job),
            }
            for job in db.scalars(
                select(Job).where(Job.import_id == batch.id).order_by(Job.created_at)
            )
        ],
    }


@router.post("/imports", status_code=202)
async def upload_csv(
    request: Request,
    key: Key,
    identity: Identity,
    db: DB,
    filename: str = Query(min_length=1, max_length=255, pattern=r"^[^\x00-\x1f\x7f]+$"),
    format: Literal["auto", "canonical", "generic", "text"] = "auto",
    repeat: bool = False,
):
    db.rollback()
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > formats.MAX_BYTES:
            raise HTTPException(413, "File exceeds the 5 MiB limit.")
        data.extend(chunk)
    if not data:
        raise HTTPException(422, "Select a nonempty CSV or text file.")
    checksum = hashlib.sha256(data).hexdigest()
    request_hash = fingerprint([filename, format, checksum, repeat])
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    existing = db.scalar(
        select(ImportBatch).where(
            ImportBatch.owner_id == identity.owner_id, ImportBatch.request_key == key
        )
    )
    if existing:
        if existing.request_hash != request_hash:
            raise HTTPException(409, "Request key already belongs to a different import.")
        return import_json(db, existing)
    duplicate = db.scalar(
        select(ImportBatch)
        .where(ImportBatch.owner_id == identity.owner_id, ImportBatch.checksum == checksum)
        .order_by(ImportBatch.created_at.desc())
        .limit(1)
    )
    if duplicate and not repeat:
        raise HTTPException(
            409,
            {
                "message": "This file was already uploaded. Open its history, or explicitly import it as additional copies.",
                "existing_import_id": str(duplicate.id),
            },
        )
    count = db.scalar(
        select(func.count())
        .select_from(ImportBatch)
        .where(
            ImportBatch.owner_id == identity.owner_id,
            ImportBatch.state.in_(["PREVIEWING", "COMMITTING", "UNDOING"]),
        )
    )
    if count >= 2:
        raise HTTPException(
            429, "Two collection imports are already running. Wait for them to finish."
        )
    batch = ImportBatch(
        id=uuid.uuid4(),
        owner_id=identity.owner_id,
        filename=filename,
        checksum=checksum,
        request_key=key,
        request_hash=request_hash,
        format=format,
    )
    batch.source_key = f"imports/{identity.owner_id}/{batch.id}/{uuid.uuid4()}.upload"
    storage.put(batch.source_key, bytes(data), "text/plain", checksum)
    db.add(batch)
    db.flush()
    enqueue(db, "IMPORT_PREVIEW", import_id=batch.id)
    db.commit()
    return import_json(db, batch)


@router.get("/imports")
def imports(identity: Identity, db: DB, offset: int = Query(0, ge=0)):
    values = db.scalars(
        select(ImportBatch)
        .where(ImportBatch.owner_id == identity.owner_id)
        .order_by(ImportBatch.created_at.desc(), ImportBatch.id)
        .offset(offset)
        .limit(21)
    ).all()
    return {
        "items": [import_json(db, value) for value in values[:20]],
        "next_offset": offset + 20 if len(values) > 20 else None,
    }


@router.get("/imports/{import_id}")
def import_detail(import_id: uuid.UUID, identity: Identity, db: DB):
    return import_json(db, owned(db, ImportBatch, import_id, identity.owner_id))


@router.get("/imports/{import_id}/rows")
def import_rows(
    import_id: uuid.UUID,
    identity: Identity,
    db: DB,
    offset: int = Query(0, ge=0),
    attention: bool = False,
    focus: int | None = Query(None, ge=1),
):
    owned(db, ImportBatch, import_id, identity.owner_id)
    condition = [ImportRow.import_id == import_id]
    unresolved = ImportRow.state.in_(["UNRESOLVED", "INVALID"])
    if attention:
        condition.append(unresolved)
    if focus is not None:
        condition.append(ImportRow.row_number == focus)
    rows = db.scalars(
        select(ImportRow).where(*condition).order_by(ImportRow.row_number).offset(offset).limit(41)
    ).all()
    visible = rows[:40]
    return {
        "items": [
            {
                "id": str(row.id),
                "row_number": row.row_number,
                "state": row.state,
                "error": row.error,
                "raw_fields": row.raw_fields,
                "normalized": row.normalized,
            }
            for row in visible
        ],
        "next_offset": offset + 40 if len(rows) > 40 and focus is None else None,
        "previous_issue": db.scalar(
            select(func.max(ImportRow.row_number)).where(
                ImportRow.import_id == import_id,
                unresolved,
                ImportRow.row_number < (focus or (rows[0].row_number if rows else 1)),
            )
        ),
        "next_issue": db.scalar(
            select(func.min(ImportRow.row_number)).where(
                ImportRow.import_id == import_id,
                unresolved,
                ImportRow.row_number > (focus or (visible[-1].row_number if visible else 0)),
            )
        ),
        "attention_count": db.scalar(
            select(func.count())
            .select_from(ImportRow)
            .where(ImportRow.import_id == import_id, unresolved)
        ),
    }


@router.post("/imports/{import_id}/preview", status_code=202)
def repreview(import_id: uuid.UUID, data: Preview, key: Key, identity: Identity, db: DB):
    batch = owned(db, ImportBatch, import_id, identity.owner_id, True)
    digest = fingerprint(data.model_dump())
    if batch.options.get("preview_request") == [key, digest]:
        return import_json(db, batch)
    if batch.options.get("undo_requested"):
        raise HTTPException(409, "This import has an undo barrier and cannot be remapped.")
    if batch.revision != data.expected_revision or batch.state not in {"REVIEW", "FAILED"}:
        raise HTTPException(409, "Import changed or is processing. Refresh its preview.")
    if not batch.source_key or (batch.expires_at and batch.expires_at <= now()):
        raise HTTPException(409, "The raw upload has expired. Upload the CSV again.")
    if db.scalar(
        select(InventoryLot.id)
        .join(ImportRow, InventoryLot.source_import_row_id == ImportRow.id)
        .where(ImportRow.import_id == batch.id)
        .limit(1)
    ):
        raise HTTPException(
            409,
            "An import with collection effects cannot be remapped. Undo or export unresolved rows.",
        )
    if set(data.mapping) - set(formats.ALIASES) or len(set(data.mapping.values())) != len(
        data.mapping
    ):
        raise HTTPException(422, "Choose distinct source columns for supported fields.")
    batch.mapping = data.mapping
    batch.options = {**data.options.model_dump(exclude_none=True), "preview_request": [key, digest]}
    batch.revision += 1
    batch.state, batch.error = "PREVIEWING", None
    enqueue(db, "IMPORT_PREVIEW", import_id=batch.id)
    db.commit()
    return import_json(db, batch)


@router.post("/imports/{import_id}/rows/{row_id}")
def repair(
    import_id: uuid.UUID, row_id: uuid.UUID, data: RowRepair, key: Key, identity: Identity, db: DB
):
    batch = owned(db, ImportBatch, import_id, identity.owner_id, True)
    if batch.state != "REVIEW" or batch.revision != data.expected_revision:
        raise HTTPException(409, "Preview changed. Refresh before repairing this row.")
    row = db.scalar(
        select(ImportRow).where(ImportRow.id == row_id, ImportRow.import_id == batch.id)
    )
    if not row or row.state == "COMMITTED":
        raise HTTPException(404, "Editable row not found.")
    if data.skip:
        row.state, row.error = "SKIPPED", "Excluded by the collector."
    else:
        printing = db.get(Printing, data.printing_id) if data.printing_id else None
        if not printing or not row.normalized:
            raise HTTPException(
                422,
                "Choose a catalog printing. Invalid quantities/metadata need CSV or mapping correction first.",
            )
        if not data.owned_cards:
            raise HTTPException(422, "Confirm this row represents cards you own.")
        if data.finish != "unknown" and data.finish not in printing.finishes:
            raise HTTPException(422, "This finish is not listed for that printing.")
        row.normalized = {
            **row.normalized,
            "scryfall_id": str(printing.id),
            "name": printing.name,
            "set_code": printing.set_code,
            "collector_number": printing.collector_number,
            "language": printing.language,
            "finish": data.finish,
            "source_metadata": {
                **row.normalized.get("source_metadata", {}),
                "manual_printing_selection": True,
            },
        }
        row.printing_id, row.state, row.error = printing.id, "READY", None
    batch.revision += 1
    db.flush()
    batch.summary = summary(db, batch)
    db.commit()
    return import_json(db, batch)


@router.post("/imports/{import_id}/confirm", status_code=202)
def confirm(import_id: uuid.UUID, data: Confirmation, key: Key, identity: Identity, db: DB):
    batch = owned(db, ImportBatch, import_id, identity.owner_id, True)
    if batch.options.get("undo_requested"):
        raise HTTPException(409, "This import was stopped for undo and cannot add more copies.")
    digest = fingerprint(data.model_dump())
    previous = batch.options.get("commit_request")
    if previous:
        if previous != [key, digest]:
            raise HTTPException(409, "This import already has a different confirmed selection.")
        if batch.state != "FAILED":
            return import_json(db, batch)
    if batch.state not in {"REVIEW", "FAILED"} or (
        not previous and batch.revision != data.expected_revision
    ):
        raise HTTPException(409, "Preview changed. Review the latest version before adding copies.")
    batch.summary = summary(db, batch)
    if not batch.summary["ready_copies"]:
        raise HTTPException(422, "No resolved rows are ready to add.")
    if batch.summary["unresolved_rows"] and not data.accept_partial:
        raise HTTPException(
            422, "Resolve the remaining rows, or explicitly add only the ready rows."
        )
    batch.options = {**batch.options, "commit_request": [key, digest]}
    batch.state, batch.error = "COMMITTING", None
    batch.revision += 1
    enqueue(db, "IMPORT_COMMIT", import_id=batch.id)
    db.commit()
    return import_json(db, batch)


@router.post("/imports/{import_id}/undo", status_code=202)
def undo(import_id: uuid.UUID, data: Revision, key: Key, identity: Identity, db: DB):
    batch = owned(db, ImportBatch, import_id, identity.owner_id, True)
    if batch.state in {"UNDOING", "UNDONE"}:
        return import_json(db, batch)
    if batch.state == "PREVIEWING" or batch.revision != data.expected_revision:
        raise HTTPException(409, "Import changed. Refresh before undoing it.")
    batch.state = "UNDOING"  # Durable barrier before any reversal job can run.
    batch.options = {**batch.options, "undo_requested": True}
    batch.revision += 1
    enqueue(db, "IMPORT_UNDO", import_id=batch.id)
    db.commit()
    return import_json(db, batch)


@router.get("/imports/{import_id}/unresolved.csv")
def unresolved(import_id: uuid.UUID, identity: Identity, db: DB):
    batch = owned(db, ImportBatch, import_id, identity.owner_id)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["source_record", "status", "error", "raw_fields_json"])
    for row in db.scalars(
        select(ImportRow)
        .where(
            ImportRow.import_id == batch.id,
            ImportRow.state.in_(["UNRESOLVED", "INVALID", "SKIPPED"]),
        )
        .order_by(ImportRow.row_number)
        .execution_options(yield_per=100)
    ):
        writer.writerow(
            [
                row.row_number,
                row.state,
                formats.safe_cell(row.error),
                formats.safe_cell(json.dumps(row.raw_fields, ensure_ascii=False)),
            ]
        )
    return Response(
        output.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="unresolved-rows.csv"'},
    )


def export_json(value):
    return {
        "id": str(value.id),
        "format": "csv" if value.format == "manabox" else value.format,
        "state": value.state,
        "snapshot_at": value.snapshot_at,
        "report": {
            **value.report,
            "warnings": [
                "This older CSV omitted some card details. Create a new export for the current formats."
            ],
        }
        if value.format == "manabox"
        else value.report,
        "requires_acknowledgment": value.format == "manabox" and not value.losses_acknowledged,
        "expires_at": value.expires_at,
        "losses_acknowledged": value.losses_acknowledged,
        "download_url": f"/api/v1/exports/{value.id}/download" if value.state == "READY" else None,
        "created_at": value.created_at,
        "safe_to_disconnect": True,
    }


@router.post("/exports", status_code=202)
def create_export(data: ExportRequest, key: Key, identity: Identity, db: DB):
    digest = fingerprint(data.model_dump())
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    existing = db.scalar(
        select(ExportBatch).where(
            ExportBatch.owner_id == identity.owner_id, ExportBatch.request_key == key
        )
    )
    if existing:
        if digest != existing.request_hash:
            raise HTTPException(409, "Request key already belongs to a different export.")
        return export_json(existing)
    if data.binder_id:
        owned(db, Binder, data.binder_id, identity.owner_id)
    if (
        db.scalar(
            select(func.count())
            .select_from(ExportBatch)
            .where(
                ExportBatch.owner_id == identity.owner_id,
                ExportBatch.state.in_(["QUEUED", "PROCESSING"]),
            )
        )
        >= 2
    ):
        raise HTTPException(429, "Two exports are already running. Wait for them to finish.")
    export = ExportBatch(
        owner_id=identity.owner_id,
        request_key=key,
        request_hash=digest,
        format=data.format,
        binder_id=data.binder_id,
    )
    db.add(export)
    db.flush()
    enqueue(db, "EXPORT", export_id=export.id)
    db.commit()
    return export_json(export)


@router.get("/exports")
def exports(identity: Identity, db: DB, offset: int = Query(0, ge=0)):
    values = db.scalars(
        select(ExportBatch)
        .where(ExportBatch.owner_id == identity.owner_id)
        .order_by(ExportBatch.created_at.desc(), ExportBatch.id)
        .offset(offset)
        .limit(21)
    ).all()
    return {
        "items": [export_json(value) for value in values[:20]],
        "next_offset": offset + 20 if len(values) > 20 else None,
    }


@router.get("/exports/{export_id}")
def export_detail(export_id: uuid.UUID, identity: Identity, db: DB):
    return export_json(owned(db, ExportBatch, export_id, identity.owner_id))


@router.post("/exports/{export_id}/acknowledge")
def acknowledge(export_id: uuid.UUID, key: Key, identity: Identity, db: DB):
    export = owned(db, ExportBatch, export_id, identity.owner_id, True)
    if export.state != "READY":
        raise HTTPException(409, "Wait for the saved export's loss report before acknowledging it.")
    export.losses_acknowledged = True
    db.commit()
    return export_json(export)


def stream_object(key, content_type, disposition):
    obj = storage.get(key)

    def chunks():
        try:
            yield from obj["Body"].iter_chunks(chunk_size=64 * 1024)
        finally:
            obj["Body"].close()

    return StreamingResponse(
        chunks(), media_type=content_type, headers={"Content-Disposition": disposition}
    )


@router.get("/exports/{export_id}/download")
def download(export_id: uuid.UUID, identity: Identity, db: DB):
    export = owned(db, ExportBatch, export_id, identity.owner_id)
    if export.state != "READY" or not export.object_key or export.expires_at <= now():
        raise HTTPException(404, "Export unavailable or expired. Generate a new snapshot.")
    if export.format == "manabox" and not export.losses_acknowledged:
        raise HTTPException(409, "Review and acknowledge this older export's omitted fields first.")
    return stream_object(
        export.object_key,
        "text/plain" if export.format == "text" else "text/csv",
        f'attachment; filename="collection-{export.id}.{"txt" if export.format == "text" else "csv"}"',
    )


@router.get("/binders")
def binders(identity: Identity, db: DB):
    counts = dict(
        db.execute(
            select(InventoryLot.binder_id, func.sum(InventoryLot.quantity_remaining))
            .where(InventoryLot.owner_id == identity.owner_id)
            .group_by(InventoryLot.binder_id)
        ).all()
    )
    return {
        "items": [
            {
                "id": str(binder.id),
                "name": binder.name,
                "kind": binder.kind,
                "notes": binder.notes,
                "version": binder.version,
                "copies": counts.get(binder.id, 0),
            }
            for binder in db.scalars(
                select(Binder).where(Binder.owner_id == identity.owner_id).order_by(Binder.name)
            )
        ]
    }


class LocationName(StrictModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=255, pattern=r"^[^\x00-\x1f\x7f]+$")
    kind: Literal["binder", "box", "other"] = "binder"
    notes: str = Field(default="", max_length=1024)


class LocationEdit(LocationName):
    expected_version: int = Field(ge=1)


@router.post("/binders", status_code=201)
def create_binder(data: LocationName, key: Key, identity: Identity, db: DB):
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    binder = db.scalar(
        select(Binder).where(Binder.owner_id == identity.owner_id, Binder.name == data.name)
    )
    if binder:
        if binder.kind != data.kind or binder.notes != data.notes:
            raise HTTPException(409, "That location name is already in use.")
        return {"id": str(binder.id)}
    if (
        db.scalar(
            select(func.count()).select_from(Binder).where(Binder.owner_id == identity.owner_id)
        )
        >= 1000
    ):
        raise HTTPException(422, "Your collection has reached the 1,000 location limit.")
    binder = Binder(owner_id=identity.owner_id, **data.model_dump())
    db.add(binder)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "That location name is already in use.") from None
    return {"id": str(binder.id)}


@router.post("/binders/{binder_id}")
def edit_binder(binder_id: uuid.UUID, data: LocationEdit, key: Key, identity: Identity, db: DB):
    binder = owned(db, Binder, binder_id, identity.owner_id, True)
    if binder.version != data.expected_version:
        raise HTTPException(409, "This location changed. Refresh before saving.")
    binder.name, binder.kind, binder.notes = data.name, data.kind, data.notes
    binder.version += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "That location name is already in use.") from None
    return {"id": str(binder.id), "version": binder.version}


def collection_conditions(db, owner_id, binder_id, q):
    condition = [InventoryLot.owner_id == owner_id, InventoryLot.quantity_remaining > 0]
    if binder_id:
        owned(db, Binder, binder_id, owner_id)
        condition.append(InventoryLot.binder_id == binder_id)
    search_text, collector_number = split_collector_search(q)
    if search_text:
        condition.append(card_name_matches(search_text))
    if collector_number:
        condition.append(func.lower(Printing.collector_number) == collector_number.lower())
    return condition


@router.get("/collection/cards")
def collection_cards(
    identity: Identity,
    db: DB,
    offset: int = Query(0, ge=0),
    binder_id: uuid.UUID | None = None,
    q: str = Query("", max_length=255),
    provider: gallery.Provider = "tcgplayer",
    color: Literal["", "W", "U", "B", "R", "G", "C", "M"] = "",
    rarity: Literal["", "common", "uncommon", "rare", "mythic", "special", "bonus"] = "",
    card_type: Literal[
        "",
        "Creature",
        "Instant",
        "Sorcery",
        "Artifact",
        "Enchantment",
        "Planeswalker",
        "Land",
        "Battle",
    ] = "",
    set_code: str = Query("", max_length=16),
    finish: Literal["", "unknown", "nonfoil", "foil", "etched"] = "",
    min_price: Decimal | None = Query(None, ge=0, max_digits=16, decimal_places=4),
    max_price: Decimal | None = Query(None, ge=0, max_digits=16, decimal_places=4),
    sort: gallery.Sort = "name",
    seed: str = Query("", max_length=64),
):
    if min_price is not None and max_price is not None and min_price > max_price:
        raise HTTPException(422, "Minimum price must not exceed maximum price.")
    return gallery.collection_cards(
        db,
        identity.owner_id,
        offset=offset,
        binder_id=binder_id,
        q=q,
        provider=provider,
        color=color,
        rarity=rarity,
        card_type=card_type,
        set_code=set_code,
        finish=finish,
        min_price=min_price,
        max_price=max_price,
        sort=sort,
        seed=seed,
    )


@router.get("/collection")
def collection(
    identity: Identity,
    db: DB,
    offset: int = Query(0, ge=0),
    binder_id: uuid.UUID | None = None,
    q: str = Query("", max_length=255),
    printing_id: uuid.UUID | None = None,
):
    condition = collection_conditions(db, identity.owner_id, binder_id, q)
    if printing_id:
        condition.append(InventoryLot.printing_id == printing_id)
    rows = db.execute(
        select(InventoryLot, Printing, Binder)
        .join(Printing)
        .join(Binder, InventoryLot.binder_id == Binder.id)
        .where(*condition)
        .order_by(Printing.name, InventoryLot.id)
        .offset(offset)
        .limit(41)
    ).all()
    return {
        "copies": db.scalar(
            select(func.coalesce(func.sum(InventoryLot.quantity_remaining), 0))
            .join(Printing)
            .where(*condition)
        ),
        "items": [
            {
                "id": str(lot.id),
                "quantity": lot.quantity_remaining,
                "printing": printing_json(printing),
                "finish": lot.finish,
                "condition": lot.condition,
                "binder": binder.name,
                "binder_id": str(binder.id),
                "binder_kind": binder.kind,
                "notes": lot.notes,
                "version": lot.version,
                "source_import_row_id": str(lot.source_import_row_id)
                if lot.source_import_row_id
                else None,
                "source_observation_id": str(lot.source_observation_id)
                if lot.source_observation_id
                else None,
            }
            for lot, printing, binder in rows[:40]
        ],
        "next_offset": offset + 40 if len(rows) > 40 else None,
    }


def lock_scan_source(db, lot, owner_id):
    if lot.source_observation_id:
        scan_id = db.get(Observation, lot.source_observation_id).scan_id
        from scanner.scan_batches import owned_batch

        owned_batch(db, scan_id, owner_id, True)


class LotEdit(StrictModel):
    expected_version: int = Field(ge=1)
    quantity: int = Field(ge=0, le=100_000)


class CardCorrection(StrictModel):
    expected_version: int = Field(ge=1)
    printing_id: uuid.UUID
    finish: Literal["unknown", "nonfoil", "foil", "etched"]
    condition: Literal["ungraded", "NM", "LP", "MP", "HP", "damaged"] | None = None
    notes: str | None = Field(default=None, max_length=4096)


@router.post("/collection/{lot_id}/details")
def correct_card(lot_id: uuid.UUID, data: CardCorrection, key: Key, identity: Identity, db: DB):
    lot = owned(db, InventoryLot, lot_id, identity.owner_id)
    lock_scan_source(db, lot, identity.owner_id)
    if lot.source_import_row_id:
        batch_id = db.get(ImportRow, lot.source_import_row_id).import_id
        batch = owned(db, ImportBatch, batch_id, identity.owner_id, True)
        if batch.state in {"UNDOING", "UNDONE"}:
            raise HTTPException(409, "This import is being undone or was undone.")
    lot = db.scalar(
        select(InventoryLot)
        .where(InventoryLot.id == lot_id, InventoryLot.owner_id == identity.owner_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if lot is None:
        raise HTTPException(404, "Collection resource not found.")
    # Optional condition/notes fields must not invalidate receipts created before
    # this API gained those fields.
    digest = fingerprint(data.model_dump(exclude_none=True))
    operation_key = f"details:{lot.id}:{hashlib.sha256(key.encode()).hexdigest()}"
    previous = db.scalar(
        select(InventoryEvent).where(InventoryEvent.operation_key == operation_key)
    )
    if previous:
        if previous.detail["request_hash"] != digest:
            raise HTTPException(409, "Request key belongs to a different card correction.")
        return previous.detail["result"]
    if lot.version != data.expected_version or lot.quantity_remaining == 0:
        raise HTTPException(
            409, "These copies changed. Close and reopen their details before saving."
        )
    printing = db.get(Printing, data.printing_id)
    if printing is None:
        raise HTTPException(404, "Printing not found in this server's catalog.")
    if data.finish != "unknown" and data.finish not in printing.finishes:
        raise HTTPException(
            422, "That finish is not available for this printing. Choose its finish."
        )
    before = {
        "printing_id": str(lot.printing_id),
        "finish": lot.finish,
        "version": lot.version,
        "condition": lot.condition,
        "notes": lot.notes,
    }
    lot.printing_id, lot.finish = data.printing_id, data.finish
    if data.condition is not None:
        lot.condition = data.condition
    if data.notes is not None:
        lot.notes = data.notes
    lot.version += 1
    if lot.source_observation_id:
        row = db.get(Observation, lot.source_observation_id)
        if row.finish != data.finish:
            row.finish, row.version = data.finish, row.version + 1
    result = {
        "id": str(lot.id),
        "printing": printing_json(printing),
        "finish": lot.finish,
        "quantity": lot.quantity_remaining,
        "version": lot.version,
        "condition": lot.condition,
        "notes": lot.notes,
    }
    db.add(
        InventoryEvent(
            lot_id=lot.id,
            operation_key=operation_key,
            kind="CORRECT_CARD",
            delta=0,
            detail={
                "request_hash": digest,
                "before": before,
                "after": {
                    "printing_id": str(lot.printing_id),
                    "finish": lot.finish,
                    "version": lot.version,
                    "condition": lot.condition,
                    "notes": lot.notes,
                },
                "result": result,
            },
        )
    )
    # Preserve original import/scan provenance. Exports and valuations join the
    # corrected printing; source-specific undo still removes these same copies.
    db.commit()
    return result


@router.post("/collection/{lot_id}/quantity")
def edit_quantity(lot_id: uuid.UUID, data: LotEdit, key: Key, identity: Identity, db: DB):
    # Import lock precedes lot lock, matching undo. Prevent edits after its barrier.
    lot = owned(db, InventoryLot, lot_id, identity.owner_id)
    lock_scan_source(db, lot, identity.owner_id)
    if lot.source_import_row_id:
        import_id = db.get(ImportRow, lot.source_import_row_id).import_id
        batch = owned(db, ImportBatch, import_id, identity.owner_id, True)
        if batch.state in {"UNDOING", "UNDONE"}:
            raise HTTPException(409, "This import is being undone or was undone.")
    lot = owned(db, InventoryLot, lot_id, identity.owner_id, True)
    existing = db.scalar(
        select(InventoryEvent).where(InventoryEvent.operation_key == f"edit:{lot.id}:{key}")
    )
    digest = fingerprint(data.model_dump())
    if existing:
        if existing.detail.get("request_hash") != digest:
            raise HTTPException(409, "Request key belongs to a different quantity change.")
        return {"id": str(lot.id), "quantity": lot.quantity_remaining, "version": lot.version}
    if lot.version != data.expected_version or data.quantity > lot.quantity_remaining:
        raise HTTPException(
            409,
            "Refresh the lot. This action only removes copies; add new copies through an import or review.",
        )
    db.add(
        InventoryEvent(
            lot_id=lot.id,
            operation_key=f"edit:{lot.id}:{key}",
            kind="REMOVE",
            delta=data.quantity - lot.quantity_remaining,
            detail={"request_hash": digest},
        )
    )
    lot.quantity_remaining = data.quantity
    lot.version += 1
    db.commit()
    return {"id": str(lot.id), "quantity": lot.quantity_remaining, "version": lot.version}


class MoveLot(StrictModel):
    binder_id: uuid.UUID
    expected_version: int = Field(ge=1)
    quantity: int | None = Field(default=None, ge=1, le=100_000)


def relocate_lot(db, lot, destination, quantity, operation_key):
    """Move copies without changing their original import/scan provenance."""
    if quantity < 1 or quantity > lot.quantity_remaining:
        raise HTTPException(
            409, "The selected quantity is no longer available. Refresh these copies."
        )
    if destination == lot.binder_id:
        raise HTTPException(422, "Choose a different storage location.")
    before = lot.binder_id
    moved = lot
    if quantity < lot.quantity_remaining:
        if lot.source_observation_id:
            raise HTTPException(
                422, "A scanned region represents one physical copy and cannot be split."
            )
        moved = InventoryLot(
            owner_id=lot.owner_id,
            printing_id=lot.printing_id,
            binder_id=destination,
            quantity_remaining=quantity,
            finish=lot.finish,
            condition=lot.condition,
            notes=lot.notes,
            purchase_price=lot.purchase_price,
            purchase_currency=lot.purchase_currency,
            misprint=lot.misprint,
            altered=lot.altered,
            source_metadata=dict(lot.source_metadata or {}),
            source_import_row_id=lot.source_import_row_id,
            source_observation_id=lot.source_observation_id,
            split_parent_id=lot.split_parent_id or lot.id,
            created_at=lot.created_at,
        )
        lot.quantity_remaining -= quantity
        db.add(moved)
        db.flush()
        db.add(
            InventoryEvent(
                lot_id=moved.id,
                operation_key=operation_key + ":child",
                kind="SPLIT_MOVE",
                delta=quantity,
                detail={"from_lot_id": str(lot.id), "from_binder_id": str(before)},
            )
        )
    else:
        lot.binder_id = destination
    lot.version += 1
    result = {
        "id": str(lot.id),
        "moved_lot_id": str(moved.id),
        "binder_id": str(destination),
        "quantity_moved": quantity,
        "quantity": lot.quantity_remaining,
        "version": lot.version,
    }
    db.add(
        InventoryEvent(
            lot_id=lot.id,
            operation_key=operation_key,
            kind="MOVE",
            delta=-quantity if moved is not lot else 0,
            detail={
                "from_binder_id": str(before),
                "to_binder_id": str(destination),
                "moved_lot_id": str(moved.id),
                "result": result,
            },
        )
    )
    return result


@router.post("/collection/{lot_id}/move")
def move_lot(lot_id: uuid.UUID, data: MoveLot, key: Key, identity: Identity, db: DB):
    lot = owned(db, InventoryLot, lot_id, identity.owner_id)
    lock_scan_source(db, lot, identity.owner_id)
    if lot.source_import_row_id:
        batch_id = db.get(ImportRow, lot.source_import_row_id).import_id
        batch = owned(db, ImportBatch, batch_id, identity.owner_id, True)
        if batch.state in {"UNDOING", "UNDONE"}:
            raise HTTPException(409, "This import is being undone or was undone.")
    lot = owned(db, InventoryLot, lot_id, identity.owner_id, True)
    digest = fingerprint(data.model_dump(exclude_none=True))
    operation_key = f"move:{lot.id}:{hashlib.sha256(key.encode()).hexdigest()[:32]}"
    previous = db.scalar(
        select(InventoryEvent).where(
            InventoryEvent.operation_key.in_([operation_key, f"move:{lot.id}:{key}"])
        )
    )
    if previous:
        if previous.detail.get("request_hash") != digest:
            raise HTTPException(409, "Request key belongs to a different move.")
        return previous.detail.get("result") or {
            "id": str(lot.id),
            "binder_id": str(lot.binder_id),
            "version": lot.version,
        }
    owned(db, Binder, data.binder_id, identity.owner_id)
    if lot.version != data.expected_version or lot.quantity_remaining == 0:
        raise HTTPException(409, "These cards changed. Refresh before moving them.")
    result = relocate_lot(
        db, lot, data.binder_id, data.quantity or lot.quantity_remaining, operation_key
    )
    event = db.scalar(select(InventoryEvent).where(InventoryEvent.operation_key == operation_key))
    event.detail = {**event.detail, "request_hash": digest}
    db.commit()
    return result


@router.get("/scans/{scan_id}/observations")
def observations(
    scan_id: uuid.UUID, identity: Identity, db: DB, provider: gallery.Provider | None = None
):
    scan = owned(db, Scan, scan_id, identity.owner_id)
    from scanner.scan_batches import batch_data

    return batch_data(db, scan, provider)


def owned_observation(db, scan_id, observation_id, owner_id, lock=False):
    from scanner.scan_batches import owned_batch

    scan = owned_batch(db, scan_id, owner_id, lock)
    query = select(Observation).where(
        Observation.scan_id == scan.id, Observation.id == observation_id
    )
    row = db.scalar(query.with_for_update() if lock else query)
    if not row:
        raise HTTPException(404, "Card region not found.")
    return scan, row


@router.get("/scans/{scan_id}/observations/{observation_id}/image")
def crop(scan_id: uuid.UUID, observation_id: uuid.UUID, identity: Identity, db: DB):
    scan, row = owned_observation(db, scan_id, observation_id, identity.owner_id)
    if not row.crop_key or not scan.expires_at or scan.expires_at <= now():
        raise HTTPException(404, "Card crop has expired or is unavailable.")
    rotation = display_rotation(row.recognition)
    if rotation:
        obj = storage.get(row.crop_key)
        try:
            data = obj["Body"].read()
        finally:
            obj["Body"].close()
        return Response(
            oriented_crop(data, rotation),
            media_type="image/jpeg",
            headers={"Content-Disposition": "inline"},
        )
    return stream_object(row.crop_key, "image/jpeg", "inline")


class Decision(StrictModel):
    expected_version: int = Field(ge=1)
    action: Literal["add", "ignore", "restore"]
    printing_id: uuid.UUID | None = None
    finish: Literal["unknown", "nonfoil", "foil", "etched"] = "unknown"
    condition: Literal["ungraded", "NM", "LP", "MP", "HP", "damaged"] = "ungraded"
    binder: str = Field(default="Scanned cards", min_length=1, max_length=255)


@router.post("/scans/{scan_id}/observations/{observation_id}/decision")
def decide(
    scan_id: uuid.UUID,
    observation_id: uuid.UUID,
    data: Decision,
    key: Key,
    identity: Identity,
    db: DB,
):
    scan, row = owned_observation(db, scan_id, observation_id, identity.owner_id, True)
    if not scan.add_to_collection and data.action == "add":
        from scanner.scan_decisions import confirm_for_deck

        confirm_for_deck(
            db,
            row,
            data.printing_id,
            data.finish,
            data.expected_version,
            key,
            fingerprint(data.model_dump()),
        )
        db.commit()
        return {"state": row.state, "lot_id": None}
    if not scan.add_to_collection and data.action == "ignore" and row.state == "COMMITTED":
        if row.version != data.expected_version:
            raise HTTPException(409, "This card changed. Refresh before ignoring it.")
        row.state, row.version = "IGNORED", row.version + 1
        row.confirmed_printing_id = None
        row.recognition = {k: v for k, v in row.recognition.items() if k != "_deck_approval"}
        db.commit()
        return {"state": row.state, "lot_id": None}
    if data.action == "restore":
        if row.version != data.expected_version or row.state != "IGNORED":
            raise HTTPException(409, "This region changed. Refresh before restoring it.")
        row.state, row.version = "NEEDS_REVIEW", row.version + 1
        if not row.recognition.get("status"):
            from scanner.scan_work import queue_again

            queue_again(db, scan)
        db.commit()
        return {"state": row.state}
    digest = fingerprint(data.model_dump())
    existing = db.scalar(
        select(InventoryLot).where(
            InventoryLot.source_observation_id == row.id, InventoryLot.split_parent_id.is_(None)
        )
    )
    if existing:
        event = db.scalar(
            select(InventoryEvent).where(InventoryEvent.operation_key == f"add:{row.id}")
        )
        if event.detail.get("decision_hash") != digest:
            raise HTTPException(
                409, "This region already has a different saved collection decision."
            )
        return {"state": row.state, "lot_id": str(existing.id)}
    if data.action == "ignore" and row.state == "IGNORED":
        return {"state": row.state}
    if row.version != data.expected_version or row.state != "NEEDS_REVIEW":
        raise HTTPException(409, "This region changed. Refresh before deciding.")
    if data.action == "ignore":
        row.state = "IGNORED"
        lot = None
    else:
        printing = db.get(Printing, data.printing_id) if data.printing_id else None
        if not printing or (data.finish != "unknown" and data.finish not in printing.finishes):
            raise HTTPException(
                422,
                "Select an exact catalog printing and a supported finish, or leave finish unknown.",
            )
        lot = add_lot(
            db,
            identity.owner_id,
            printing.id,
            {
                "quantity": 1,
                "binder": data.binder,
                "finish": data.finish,
                "condition": data.condition,
            },
            observation_id=row.id,
        )
        db.flush()
        event = db.scalar(
            select(InventoryEvent).where(InventoryEvent.operation_key == f"add:{row.id}")
        )
        event.detail = {**event.detail, "decision_hash": digest, "decision": "manual"}
        row.state = "COMMITTED"
        row.finish = data.finish
    row.version += 1
    db.commit()
    return {"state": row.state, "lot_id": str(lot.id) if lot else None}
