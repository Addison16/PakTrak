"""Private scan review, source-specific deletion and crop repair."""

import hashlib
import io
import json
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Annotated, Literal

import numpy as np
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from scanner import detection, storage
from scanner.account_access import check_scan_access, check_scan_allowance
from scanner.auth import DB, Identity
from scanner.card_images import load_image
from scanner.catalog import printing_json
from scanner.crop_orientation import display_rotation
from scanner.models import (
    Binder,
    CardPrice,
    DataFeed,
    ExportRow,
    InventoryEvent,
    InventoryLot,
    Job,
    Observation,
    Printing,
    Scan,
    User,
    now,
)
from scanner.recognition_policy import AUTO_IMPORT_THRESHOLD
from scanner.scan_work import new_observation_finish, queue_again, reset_recognition
from scanner.transfers import add_lot

router = APIRouter(prefix="/api/v1/scans", tags=["scan batches"])
Key = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


@router.get("/{scan_id}/reference/{printing_id}/image")
def reference_image(scan_id: uuid.UUID, printing_id: uuid.UUID, identity: Identity, db: DB):
    owned_batch(db, scan_id, identity.owner_id)
    card = db.get(Printing, printing_id)
    if not card:
        raise HTTPException(404, "Printing not found.")
    db.expunge(card)
    db.rollback()
    data, content_type, digest = load_image(card)
    return Response(
        data,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": '"' + digest + '"',
        },
    )


def owned_batch(db, scan_id, owner_id, lock=False, include_deleted=False):
    if lock:
        db.scalar(select(User).where(User.id == owner_id).with_for_update())
        # Same lock order as recognition: owner, job, scan, observation, lot.
        db.scalar(
            select(Job)
            .join(Scan)
            .where(Job.scan_id == scan_id, Scan.owner_id == owner_id)
            .with_for_update(of=Job)
        )
    query = select(Scan).where(Scan.id == scan_id, Scan.owner_id == owner_id)
    if not include_deleted:
        query = query.where(Scan.deleted_at.is_(None))
    scan = db.scalar(
        query.with_for_update().execution_options(populate_existing=True) if lock else query
    )
    if not scan:
        raise HTTPException(404, "Batch not found.")
    return scan


def batch_rows(db, scan):
    return db.scalars(
        select(Observation).where(Observation.scan_id == scan.id).order_by(Observation.region_index)
    ).all()


def batch_lots(db, scan, lock=False):
    query = (
        select(InventoryLot)
        .join(Observation, InventoryLot.source_observation_id == Observation.id)
        .where(
            Observation.scan_id == scan.id,
            InventoryLot.owner_id == scan.owner_id,
        )
        .order_by(InventoryLot.id)
    )
    return db.scalars(
        query.with_for_update(of=InventoryLot).execution_options(populate_existing=True)
        if lock
        else query
    ).all()


def finish_info(scan, rows, lots):
    by_observation = {lot.source_observation_id: lot for lot in lots}
    active = [row for row in rows if row.state != "IGNORED"]
    finishes = {
        row.id: by_observation[row.id].finish if row.id in by_observation else row.finish
        for row in active
    }
    foil_ids = [str(row.id) for row in active if finishes[row.id] in {"foil", "etched"}]
    token = hashlib.sha256(
        json.dumps(
            [
                scan.foil_count,
                [(str(r.id), r.version, r.state, r.finish) for r in rows],
                [(str(lot.id), lot.version) for lot in lots],
            ]
        ).encode()
    ).hexdigest()
    return {
        "foil_count": scan.foil_count,
        "foil_ids": foil_ids,
        "etched_ids": [str(row.id) for row in active if finishes[row.id] == "etched"],
        "confirmed": bool(active)
        and scan.foil_count == len(foil_ids)
        and all(value != "unknown" for value in finishes.values()),
        "token": token,
    }


def owned_elsewhere(db, owner_id, names, batch_lot_ids):
    """Copies of each card name already in the collection, not counting this batch."""
    names = {name.lower() for name in names}
    if not names:
        return {}
    condition = [
        InventoryLot.owner_id == owner_id,
        InventoryLot.quantity_remaining > 0,
        func.lower(Printing.name).in_(names),
    ]
    if batch_lot_ids:
        condition.append(InventoryLot.id.not_in(batch_lot_ids))
    found = {}
    for name, location, quantity in db.execute(
        select(func.lower(Printing.name), Binder.name, func.sum(InventoryLot.quantity_remaining))
        .join(Printing, Printing.id == InventoryLot.printing_id)
        .join(Binder, Binder.id == InventoryLot.binder_id)
        .where(*condition)
        .group_by(func.lower(Printing.name), Binder.name)
        .order_by(func.sum(InventoryLot.quantity_remaining).desc(), Binder.name)
    ):
        entry = found.setdefault(name, {"copies": 0, "locations": []})
        entry["copies"] += int(quantity)
        if len(entry["locations"]) < 2:
            entry["locations"].append(location)
    return found


def batch_data(db, scan, provider=None):
    if provider is None:
        provider = db.get(User, scan.owner_id).preferred_price_source or "tcgplayer"
    rows, lots = batch_rows(db, scan), batch_lots(db, scan)
    by_observation = {lot.source_observation_id: lot for lot in lots}
    ids = {lot.printing_id for lot in lots}
    ids.update(row.confirmed_printing_id for row in rows if row.confirmed_printing_id)
    for row in rows:
        ids.update(uuid.UUID(c["printing_id"]) for c in row.recognition.get("candidates", []))
    cards = (
        {card.id: card for card in db.scalars(select(Printing).where(Printing.id.in_(ids)))}
        if ids
        else {}
    )
    prices = {}
    if ids:
        for price in db.scalars(
            select(CardPrice).where(CardPrice.printing_id.in_(ids), CardPrice.provider == provider)
        ):
            prices.setdefault(price.printing_id, {})[price.finish] = price.amount
    locations = (
        {
            b.id: b.name
            for b in db.scalars(
                select(Binder).where(Binder.id.in_({lot.binder_id for lot in lots}))
            )
        }
        if lots
        else {}
    )
    elsewhere = owned_elsewhere(
        db,
        scan.owner_id,
        {card.name for card in cards.values()},
        {lot.id for lot in lots},
    )
    low = high = Decimal(0)
    priced = unknown_finish = 0
    items = []
    for row in rows:
        result = row.recognition
        candidates = [
            {**c, "printing": printing_json(cards[uuid.UUID(c["printing_id"])])}
            for c in result.get("candidates", [])
            if uuid.UUID(c["printing_id"]) in cards
        ]
        lot = by_observation.get(row.id)
        card_id = (
            lot.printing_id
            if lot
            else row.confirmed_printing_id
            or (uuid.UUID(candidates[0]["printing_id"]) if candidates else None)
        )
        finish = lot.finish if lot else row.finish
        quantity = lot.quantity_remaining if lot else 1
        quotes = prices.get(card_id, {})
        values = (
            list(quotes.values())
            if finish == "unknown"
            else ([quotes[finish]] if finish in quotes else [])
        )
        estimate = {"min": str(min(values)), "max": str(max(values))} if values else None
        if row.state != "IGNORED" and quantity:
            if values:
                low += min(values) * quantity
                high += max(values) * quantity
                priced += quantity
            if finish == "unknown":
                unknown_finish += quantity
        items.append(
            {
                "id": str(row.id),
                "region_index": row.region_index,
                "polygon": row.polygon,
                "state": row.state,
                "version": row.version,
                "finish": finish,
                "detector_version": row.detector_version,
                "rotation": display_rotation(result),
                "crop_url": f"/api/v1/scans/{scan.id}/observations/{row.id}/image?v={row.version}"
                if row.crop_key and scan.expires_at and scan.expires_at > now()
                else None,
                "recognition": {
                    k: v
                    for k, v in result.items()
                    if k not in {"title_text", "footer_text", "candidates"}
                    and not k.startswith("_")
                },
                "candidates": candidates,
                "confirmed_printing": printing_json(cards[row.confirmed_printing_id])
                if row.confirmed_printing_id in cards
                else None,
                "estimate": estimate,
                "owned_elsewhere": {
                    **elsewhere[cards[card_id].name.lower()],
                    "name": cards[card_id].name,
                }
                if card_id in cards and cards[card_id].name.lower() in elsewhere
                else None,
                "lot": {
                    "id": str(lot.id),
                    "version": lot.version,
                    "printing": printing_json(cards[lot.printing_id]),
                    "finish": lot.finish,
                    "condition": lot.condition,
                    "quantity": lot.quantity_remaining,
                    "binder": locations.get(lot.binder_id),
                }
                if lot
                else None,
            }
        )
    active = [row for row in rows if row.state != "IGNORED"]
    feed = db.get(DataFeed, "scryfall" if provider == "tcgplayer" else provider)
    return {
        "items": items,
        "add_to_collection": scan.add_to_collection,
        "finishes": finish_info(scan, rows, lots),
        "summary": {
            "regions": len(rows),
            "cards": len(active),
            "identified": sum(bool(r.recognition.get("candidates")) for r in active),
            "checked": sum(
                bool(r.recognition.get("status")) or r.state != "NEEDS_REVIEW" for r in rows
            ),
            "imported": sum(lot.quantity_remaining for lot in lots),
            "confirmed": sum(row.state == "COMMITTED" for row in active),
            "needs_review": sum(r.state == "NEEDS_REVIEW" for r in active),
            "provider": provider,
            "value_min": str(low) if priced else None,
            "value_max": str(high) if priced else None,
            "priced_cards": priced,
            "unpriced_cards": sum(
                (by_observation[r.id].quantity_remaining if r.id in by_observation else 1)
                for r in active
            )
            - priced,
            "unknown_finish": unknown_finish,
            "prices_updated_at": feed.updated_at if feed else None,
            "auto_add_enabled": True,
            "auto_add_threshold": AUTO_IMPORT_THRESHOLD,
        },
    }


class FinishSelection(Strict):
    foil_count: int = Field(ge=0, le=32, strict=True)
    foil_ids: list[uuid.UUID] = Field(max_length=32)
    etched_ids: list[uuid.UUID] = Field(default_factory=list, max_length=32)
    token: str = Field(min_length=64, max_length=64)


@router.post("/{scan_id}/finishes")
def select_finishes(
    scan_id: uuid.UUID, data: FinishSelection, key: Key, identity: Identity, db: DB
):
    scan = owned_batch(db, scan_id, identity.owner_id, True)
    digest = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    previous = scan.finish_selection or {}
    if previous.get("key") == key:
        if previous.get("hash") != digest:
            raise HTTPException(409, "This request key belongs to a different foil selection.")
        return previous["result"]
    job = db.scalar(select(Job).where(Job.scan_id == scan.id))
    if job and job.state in {"RUNNING", "QUEUED"}:
        raise HTTPException(409, "Wait for card identification to finish before saving foil cards.")
    rows, lots = batch_rows(db, scan), batch_lots(db, scan, True)
    if data.token != finish_info(scan, rows, lots)["token"]:
        raise HTTPException(
            409,
            "This batch changed. Review the refreshed cards and save your foil selection again.",
        )
    active = [row for row in rows if row.state != "IGNORED"]
    foil_ids, etched_ids = set(data.foil_ids), set(data.etched_ids)
    if (
        not active
        or len(foil_ids) != data.foil_count
        or len(foil_ids) != len(data.foil_ids)
        or len(etched_ids) != len(data.etched_ids)
        or not etched_ids <= foil_ids
        or not foil_ids <= {row.id for row in active}
    ):
        raise HTTPException(
            422,
            "Select exactly the foil count from this batch's active cards. Include etched cards in that count.",
        )
    by_observation = {lot.source_observation_id: lot for lot in lots}
    for index, row in enumerate(rows):
        if row.state == "IGNORED":
            continue
        finish = "etched" if row.id in etched_ids else "foil" if row.id in foil_ids else "nonfoil"
        lot = by_observation.get(row.id)
        candidate = next(iter(row.recognition.get("candidates", [])), {})
        printing_id = (
            lot.printing_id if lot else row.confirmed_printing_id or candidate.get("printing_id")
        )
        card = db.get(Printing, uuid.UUID(str(printing_id))) if printing_id else None
        if card and finish not in card.finishes:
            raise HTTPException(
                422,
                f"Card {index + 1} ({card.name}) is not listed in {finish}. Edit its printing or choose an available finish before saving.",
            )
        if row.finish != finish:
            row.finish, row.version = finish, row.version + 1
        if lot and lot.finish != finish:
            before = {"finish": lot.finish, "version": lot.version}
            lot.finish, lot.version = finish, lot.version + 1
            db.add(
                InventoryEvent(
                    lot_id=lot.id,
                    operation_key=f"scan-finish:{scan.id}:{lot.id}:{hashlib.sha256(key.encode()).hexdigest()[:16]}",
                    kind="SET_SCAN_FINISH",
                    delta=0,
                    detail={
                        "scan_id": str(scan.id),
                        "before": before,
                        "after": {"finish": finish, "version": lot.version},
                    },
                )
            )
    scan.foil_count = data.foil_count
    result = {"foil_cards": len(foil_ids), "nonfoil_cards": len(active) - len(foil_ids)}
    scan.finish_selection = {"key": key, "hash": digest, "result": result}
    db.commit()
    return result


def deletion_token(scan, lots):
    return hashlib.sha256(
        json.dumps(
            [str(scan.id), [(str(lot.id), lot.version, lot.quantity_remaining) for lot in lots]],
            sort_keys=True,
        ).encode()
    ).hexdigest()


@router.get("/{scan_id}/deletion-preview")
def deletion_preview(scan_id: uuid.UUID, identity: Identity, db: DB):
    scan = owned_batch(db, scan_id, identity.owner_id)
    lots = batch_lots(db, scan)
    return {
        "copies": sum(lot.quantity_remaining for lot in lots),
        "token": deletion_token(scan, lots),
        "warning": "Deleting this batch stops its processing and removes every remaining collection copy added by this scan, including copies moved to another binder or corrected later. Copies from other batches stay in your collection. Deck lists remain saved; their owned-card counts will update. Guest scan allowance is not restored.",
    }


class DeleteBatch(Strict):
    confirmed: Literal[True]
    token: str = Field(min_length=64, max_length=64)


@router.delete("/{scan_id}")
def delete_batch(scan_id: uuid.UUID, data: DeleteBatch, key: Key, identity: Identity, db: DB):
    scan = owned_batch(db, scan_id, identity.owner_id, True, True)
    job = db.scalar(select(Job).where(Job.scan_id == scan.id))
    if scan.deleted_at:
        return {
            "deleted": True,
            "copies_removed": (job.result or {}).get("deleted_copies", 0) if job else 0,
        }
    lots = batch_lots(db, scan, True)
    if data.token != deletion_token(scan, lots):
        raise HTTPException(
            409,
            "The copies in this batch changed. Reopen Delete batch to review the updated count.",
        )
    removed = 0
    for lot in lots:
        if not lot.quantity_remaining:
            continue
        removed += lot.quantity_remaining
        db.add(
            InventoryEvent(
                lot_id=lot.id,
                operation_key=f"delete-scan:{scan.id}:{lot.id}",
                kind="DELETE_SCAN",
                delta=-lot.quantity_remaining,
                detail={"scan_id": str(scan.id)},
            )
        )
        lot.quantity_remaining = 0
        lot.version += 1
    scan.deleted_at = now()
    scan.state = "FAILED"  # hidden immediately; retention maintenance removes private objects
    if job:
        job.state, job.stage, job.completed_at = "FAILED", "Batch deleted", now()
        job.lease_token = job.lease_until = None
        job.error_code, job.error_message = "BATCH_DELETED", None
        job.result = {"deleted_copies": removed}
    db.commit()
    return {"deleted": True, "copies_removed": removed}


class Reidentify(Strict):
    find_missing: bool = False


@router.post("/{scan_id}/identify", status_code=202)
def reidentify(scan_id: uuid.UUID, data: Reidentify, key: Key, identity: Identity, db: DB):
    scan = owned_batch(db, scan_id, identity.owner_id, True)
    if not scan.prepared_key or not scan.expires_at or scan.expires_at <= now():
        raise HTTPException(409, "This photo is unavailable. Upload a new photo.")
    job = db.scalar(select(Job).where(Job.scan_id == scan.id))
    if job and job.state in {"RUNNING", "QUEUED"}:
        return {"queued": True}
    if data.find_missing:
        # Existing regions can be rechecked at the limit; workers charge only additions.
        check_scan_access(db.get(User, identity.owner_id))
    for row in batch_rows(db, scan):
        if row.state == "NEEDS_REVIEW":
            row.recognition = reset_recognition(row.recognition)
            row.version += 1
    queue_again(db, scan, redetect=data.find_missing)
    db.commit()
    return {"queued": True}


class Geometry(Strict):
    polygon: list[list[float]] = Field(min_length=4, max_length=4)
    expected_version: int | None = Field(default=None, ge=1)


class Orientation(Strict):
    expected_version: int = Field(ge=1)
    rotation: Literal[0, 180]


@router.put("/{scan_id}/observations/{observation_id}/orientation")
def set_orientation(
    scan_id: uuid.UUID,
    observation_id: uuid.UUID,
    data: Orientation,
    key: Key,
    identity: Identity,
    db: DB,
):
    scan = owned_batch(db, scan_id, identity.owner_id, True)
    row = db.scalar(
        select(Observation)
        .where(Observation.id == observation_id, Observation.scan_id == scan.id)
        .with_for_update()
    )
    if not row:
        raise HTTPException(404, "Card region not found.")
    if not row.crop_key or not scan.expires_at or scan.expires_at <= now():
        raise HTTPException(409, "The photo is no longer available for rotation.")
    digest = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    previous = row.recognition.get("_orientation_request", {})
    if previous.get("key") == key:
        if previous.get("hash") != digest:
            raise HTTPException(409, "This request key belongs to a different photo rotation.")
        return {"id": str(row.id)}
    if row.version != data.expected_version:
        raise HTTPException(409, "This card changed. Refresh before flipping its photo.")
    result = reset_recognition(row.recognition) if row.state == "NEEDS_REVIEW" else row.recognition
    row.recognition = {
        **result,
        "_orientation": data.rotation,
        "_orientation_request": {"key": key, "hash": digest},
    }
    row.version += 1
    if row.state == "NEEDS_REVIEW":
        queue_again(db, scan)
    db.commit()
    return {"id": str(row.id)}


def save_geometry(scan_id, observation_id, data, key, identity, db):
    if not detection.polygon_valid(data.polygon):
        raise HTTPException(
            422, "Outline four corners of one card inside the photo, without crossing the edges."
        )
    scan = owned_batch(db, scan_id, identity.owner_id, True)
    if not scan.prepared_key or not scan.expires_at or scan.expires_at <= now():
        raise HTTPException(409, "The photo is no longer available for crop editing.")
    new_id = uuid.uuid5(scan.id, "manual:" + key)
    row = db.get(Observation, observation_id or new_id)
    digest = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    if (
        row
        and row.scan_id == scan.id
        and row.recognition.get("_crop_request", {}).get("key") == key
    ):
        if row.recognition["_crop_request"]["hash"] != digest:
            raise HTTPException(409, "This request key belongs to a different crop edit.")
        return {"id": str(row.id)}
    if observation_id:
        if not row or row.scan_id != scan.id:
            raise HTTPException(404, "Card region not found.")
        if row.version != data.expected_version or row.state != "NEEDS_REVIEW":
            raise HTTPException(409, "This card changed. Refresh before adjusting its crop.")
    elif row:
        if row.polygon != data.polygon:
            raise HTTPException(409, "This request key belongs to a different crop.")
        return {"id": str(row.id)}
    rows = batch_rows(db, scan)
    if any(
        r.id != (row.id if row else None) and detection.overlap(data.polygon, r.polygon) > 0.65
        for r in rows
    ):
        raise HTTPException(
            409, "That card already has a region. Edit its existing outline instead."
        )
    user = db.get(User, identity.owner_id)
    if not row:
        if len(rows) >= 32:
            raise HTTPException(409, "This batch already has 32 card regions.")
        check_scan_allowance(user)
    # Geometry edits are bounded server crops, not recognition in the request.
    obj = storage.get(scan.prepared_key)
    try:
        image = np.asarray(Image.open(io.BytesIO(obj["Body"].read())).convert("RGB"))
    finally:
        obj["Body"].close()
    crop_key = f"derived/{scan.id}/manual/{uuid.uuid4()}.jpg"
    storage.put(crop_key, detection.crop_region(image, data.polygon), "image/jpeg")
    if not row:
        row = Observation(
            id=new_id,
            scan_id=scan.id,
            region_index=max((r.region_index for r in rows), default=-1) + 1,
            polygon=data.polygon,
            crop_key=crop_key,
            detector_version="manual-v1",
            finish=new_observation_finish(db, scan),
        )
        db.add(row)
        user.scan_cards_used += 1
    else:
        row.polygon, row.crop_key, row.recognition = data.polygon, crop_key, {}
        row.detector_version, row.version = "manual-v1", row.version + 1
    row.recognition = {"_crop_request": {"key": key, "hash": digest}}
    queue_again(db, scan)
    db.commit()
    return {"id": str(row.id)}


@router.post("/{scan_id}/observations", status_code=201)
def add_region(scan_id: uuid.UUID, data: Geometry, key: Key, identity: Identity, db: DB):
    return save_geometry(scan_id, None, data, key, identity, db)


@router.put("/{scan_id}/observations/{observation_id}/geometry")
def edit_region(
    scan_id: uuid.UUID,
    observation_id: uuid.UUID,
    data: Geometry,
    key: Key,
    identity: Identity,
    db: DB,
):
    return save_geometry(scan_id, observation_id, data, key, identity, db)


class Approval(Strict):
    observation_id: uuid.UUID
    expected_version: int = Field(ge=1)
    printing_id: uuid.UUID
    finish: Literal["unknown", "nonfoil", "foil", "etched"] = "unknown"


class Approvals(Strict):
    items: list[Approval] = Field(min_length=1, max_length=32)
    binder: str = Field(default="Scanned cards", min_length=1, max_length=255)
    condition: Literal["ungraded", "NM", "LP", "MP", "HP", "damaged"] = "ungraded"


@router.post("/{scan_id}/approve")
def approve_cards(scan_id: uuid.UUID, data: Approvals, key: Key, identity: Identity, db: DB):
    scan = owned_batch(db, scan_id, identity.owner_id, True)
    if not data.binder.strip():
        raise HTTPException(422, "Enter a storage location for these cards.")
    if len({item.observation_id for item in data.items}) != len(data.items):
        raise HTTPException(422, "Select each card only once.")
    digest = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    for item in data.items:
        row = db.scalar(
            select(Observation)
            .where(Observation.id == item.observation_id, Observation.scan_id == scan.id)
            .with_for_update()
        )
        if not row:
            raise HTTPException(404, "Card region not found.")
        if not scan.add_to_collection:
            from scanner.scan_decisions import confirm_for_deck

            confirm_for_deck(
                db, row, item.printing_id, item.finish, item.expected_version, key, digest
            )
            continue
        event = db.scalar(
            select(InventoryEvent).where(InventoryEvent.operation_key == f"add:{row.id}")
        )
        if (
            event
            and event.detail.get("approval_key") == key
            and event.detail.get("approval_hash") == digest
        ):
            continue
        if row.version != item.expected_version or row.state != "NEEDS_REVIEW":
            raise HTTPException(
                409, "A selected card changed. Refresh before approving these cards."
            )
        card = db.get(Printing, item.printing_id)
        if not card or item.finish != "unknown" and item.finish not in card.finishes:
            raise HTTPException(
                422, "Choose a catalog printing and a finish supported by that printing."
            )
        add_lot(
            db,
            identity.owner_id,
            card.id,
            {
                "quantity": 1,
                "binder": data.binder.strip(),
                "finish": item.finish,
                "condition": data.condition,
            },
            observation_id=row.id,
        )
        db.flush()
        event = db.scalar(
            select(InventoryEvent).where(InventoryEvent.operation_key == f"add:{row.id}")
        )
        event.detail = {
            **event.detail,
            "decision": "manual",
            "approval_key": key,
            "approval_hash": digest,
        }
        row.state, row.version = "COMMITTED", row.version + 1
        row.finish = item.finish
    db.commit()
    return (
        {"imported": len(data.items)} if scan.add_to_collection else {"confirmed": len(data.items)}
    )


UNDO_WINDOW_SECONDS = 120


class UndoApproval(Strict):
    expected_version: int = Field(ge=1)


@router.post("/{scan_id}/observations/{observation_id}/undo-approval")
def undo_approval(
    scan_id: uuid.UUID, observation_id: uuid.UUID, data: UndoApproval, identity: Identity, db: DB
):
    """Reverse a just-made manual approval, as if it had not happened.

    Only an untouched copy qualifies: approved by hand in this batch within the
    last two minutes, never edited, moved, removed or exported. Anything else
    stays a normal collection change and is corrected from the collection.
    """
    scan = owned_batch(db, scan_id, identity.owner_id, True)
    row = db.scalar(
        select(Observation)
        .where(Observation.id == observation_id, Observation.scan_id == scan.id)
        .with_for_update()
    )
    if not row:
        raise HTTPException(404, "Card region not found.")
    if not scan.add_to_collection or row.state != "COMMITTED":
        raise HTTPException(409, "This card has no approval to undo.")
    if row.version != data.expected_version:
        raise HTTPException(409, "This card changed. Refresh before undoing.")
    lot = db.scalar(
        select(InventoryLot)
        .where(InventoryLot.source_observation_id == row.id, InventoryLot.split_parent_id.is_(None))
        .with_for_update()
    )
    events = (
        list(db.scalars(select(InventoryEvent).where(InventoryEvent.lot_id == lot.id)))
        if lot
        else []
    )
    added = next((event for event in events if event.operation_key == f"add:{row.id}"), None)
    if (
        not lot
        or not added
        or len(events) != 1
        or added.detail.get("decision") != "manual"
        or lot.version != 1
        or lot.quantity_remaining != 1
        or now() - added.created_at > timedelta(seconds=UNDO_WINDOW_SECONDS)
        or db.scalar(select(ExportRow.lot_id).where(ExportRow.lot_id == lot.id).limit(1))
    ):
        raise HTTPException(
            409, "This copy can no longer be undone here. Edit or remove it from your collection."
        )
    # The add event cascades with the lot, so approving again later starts fresh.
    db.delete(lot)
    row.state, row.version = "NEEDS_REVIEW", row.version + 1
    db.commit()
    return {"state": row.state, "version": row.version}
