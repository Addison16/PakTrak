"""Preview and atomically apply changes to explicitly selected owned printings."""

import hashlib
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field
from sqlalchemy import select

from scanner.auth import DB, Identity
from scanner.collection_api import (
    Key,
    StrictModel,
    fingerprint,
    lock_scan_source,
    owned,
    relocate_lot,
)
from scanner.models import (
    Binder,
    ImportBatch,
    ImportRow,
    InventoryEvent,
    InventoryLot,
    Printing,
    User,
)

router = APIRouter(prefix="/api/v1/collection/bulk", tags=["collection"])


class BulkSelection(StrictModel):
    printing_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)
    source_binder_id: uuid.UUID | None = None
    action: Literal["move", "finish"]
    binder_id: uuid.UUID | None = None
    finish: Literal["unknown", "nonfoil", "foil", "etched"] | None = None


class BulkApply(BulkSelection):
    token: str = Field(min_length=64, max_length=64)


def selection(db, owner, data, lock=False):
    if len(set(data.printing_ids)) != len(data.printing_ids):
        raise HTTPException(422, "Select each printing only once.")
    if data.action == "move":
        if data.binder_id is None:
            raise HTTPException(422, "Choose a destination.")
        owned(db, Binder, data.binder_id, owner)
    elif data.finish is None:
        raise HTTPException(422, "Choose a finish.")
    if data.source_binder_id:
        owned(db, Binder, data.source_binder_id, owner)
    conditions = [
        InventoryLot.owner_id == owner,
        InventoryLot.quantity_remaining > 0,
        InventoryLot.printing_id.in_(data.printing_ids),
    ]
    if data.source_binder_id:
        conditions.append(InventoryLot.binder_id == data.source_binder_id)
    rows = db.scalars(
        select(InventoryLot).where(*conditions).order_by(InventoryLot.id).limit(1001)
    ).all()
    if len(rows) > 1000:
        raise HTTPException(422, "Select fewer cards or choose a source storage location.")
    if {row.printing_id for row in rows} != set(data.printing_ids):
        raise HTTPException(
            409, "Some selected cards are no longer in this view. Refresh your collection."
        )
    if lock:
        for row in rows:
            lock_scan_source(db, row, owner)
        batch_ids = sorted(
            {
                db.get(ImportRow, row.source_import_row_id).import_id
                for row in rows
                if row.source_import_row_id
            }
        )
        for batch_id in batch_ids:
            batch = owned(db, ImportBatch, batch_id, owner, True)
            if batch.state in {"UNDOING", "UNDONE"}:
                raise HTTPException(
                    409, "A selected import is being undone. Refresh your collection."
                )
        rows = db.scalars(
            select(InventoryLot)
            .where(*conditions)
            .order_by(InventoryLot.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).all()
    cards = {
        row.id: row
        for row in db.scalars(select(Printing).where(Printing.id.in_(data.printing_ids)))
    }
    if data.action == "finish" and data.finish != "unknown":
        invalid = [card.name for card in cards.values() if data.finish not in card.finishes]
        if invalid:
            raise HTTPException(
                422, "Selected finish is unavailable for: " + ", ".join(invalid[:5])
            )
    bins = {row.id: row.name for row in db.scalars(select(Binder).where(Binder.owner_id == owner))}
    payload = data.model_dump(exclude={"token"}, mode="json")
    groups = [
        {
            "id": str(row.id),
            "printing_id": str(row.printing_id),
            "name": cards[row.printing_id].name,
            "binder": bins[row.binder_id],
            "quantity": row.quantity_remaining,
            "finish": row.finish,
            "condition": row.condition,
            "version": row.version,
        }
        for row in rows
    ]
    token = fingerprint({"owner": str(owner), "selection": payload, "groups": groups})
    return rows, groups, token


@router.post("/preview")
def preview(data: BulkSelection, identity: Identity, db: DB):
    rows, groups, token = selection(db, identity.owner_id, data)
    affected = [
        row
        for row in rows
        if (row.binder_id != data.binder_id if data.action == "move" else row.finish != data.finish)
    ]
    return {
        "token": token,
        "groups": groups,
        "copies": sum(row.quantity_remaining for row in affected),
        "groups_changed": len(affected),
    }


@router.post("/apply")
def apply(data: BulkApply, key: Key, identity: Identity, db: DB):
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    operation = "bulk:" + hashlib.sha256(f"{identity.owner_id}:{key}".encode()).hexdigest()
    digest = fingerprint(data.model_dump(mode="json"))
    previous = db.scalar(select(InventoryEvent).where(InventoryEvent.operation_key == operation))
    if previous:
        if previous.detail.get("request_hash") != digest:
            raise HTTPException(409, "Request key belongs to a different bulk change.")
        return previous.detail["result"]
    rows, _, token = selection(db, identity.owner_id, data, lock=True)
    if token != data.token:
        raise HTTPException(
            409, "These copies changed. Preview your selection again before saving."
        )
    affected = 0
    for row in rows:
        if data.action == "move" and row.binder_id != data.binder_id:
            affected += row.quantity_remaining
            relocate_lot(
                db, row, data.binder_id, row.quantity_remaining, operation + ":" + str(row.id)
            )
        elif data.action == "finish" and row.finish != data.finish:
            affected += row.quantity_remaining
            before = row.finish
            row.finish = data.finish
            row.version += 1
            if row.source_observation_id:
                from scanner.models import Observation

                observation = db.get(Observation, row.source_observation_id)
                observation.finish = row.finish
                observation.version += 1
            db.add(
                InventoryEvent(
                    lot_id=row.id,
                    operation_key=operation + ":" + str(row.id),
                    kind="BULK_FINISH",
                    delta=0,
                    detail={"before": before, "after": row.finish},
                )
            )
    result = {"copies_changed": affected, "groups": len(rows)}
    db.add(
        InventoryEvent(
            lot_id=rows[0].id,
            operation_key=operation,
            kind="BULK_CHANGE",
            delta=0,
            detail={"request_hash": digest, "result": result},
        )
    )
    db.commit()
    return result
