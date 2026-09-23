"""Turn reviewed photo cards into deck plans without charging or copying inventory."""

import uuid
from collections import Counter
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field
from sqlalchemy import func, select

from scanner.auth import DB, Identity
from scanner.catalog import printing_json
from scanner.collection_api import Key, StrictModel, fingerprint, owned
from scanner.decks_api import deck_detail
from scanner.models import (
    Deck,
    DeckCard,
    DeckScanCard,
    InventoryLot,
    Job,
    Observation,
    Printing,
    Scan,
    User,
    now,
)

router = APIRouter(prefix="/api/v1/deck-scans", tags=["deck photos"])


class Preview(StrictModel):
    deck_id: uuid.UUID
    scan_ids: list[uuid.UUID] = Field(min_length=1, max_length=32)


class SourceChoice(StrictModel):
    observation_id: uuid.UUID
    section: Literal["main", "sideboard", "commander"] = "main"


class Save(Preview):
    expected_version: int = Field(ge=1)
    token: str = Field(min_length=64, max_length=64)
    items: list[SourceChoice] = Field(min_length=1, max_length=1024)


def preview_data(db, owner_id, deck, scan_ids, lock=False):
    if len(set(scan_ids)) != len(scan_ids):
        raise HTTPException(422, "Select each photo batch only once.")
    scans = list(
        db.scalars(
            select(Scan)
            .where(Scan.id.in_(scan_ids), Scan.owner_id == owner_id, Scan.deleted_at.is_(None))
            .order_by(Scan.created_at, Scan.id)
        )
    )
    if len(scans) != len(scan_ids):
        raise HTTPException(404, "A selected photo batch is unavailable.")
    if lock:
        list(
            db.scalars(
                select(InventoryLot)
                .join(Observation, Observation.id == InventoryLot.source_observation_id)
                .where(Observation.scan_id.in_(scan_ids))
                .order_by(InventoryLot.id)
                .with_for_update(of=InventoryLot)
            )
        )
    rows = db.execute(
        select(Observation, InventoryLot)
        .join(Scan, Scan.id == Observation.scan_id)
        .outerjoin(InventoryLot, InventoryLot.source_observation_id == Observation.id)
        .where(Observation.scan_id.in_(scan_ids))
        .order_by(Scan.created_at, Scan.id, Observation.region_index)
    ).all()
    used = set(
        db.scalars(
            select(DeckScanCard.observation_id).where(
                DeckScanCard.deck_id == deck.id,
                DeckScanCard.observation_id.in_([row.id for row, _ in rows]),
            )
        )
    )
    ids = {
        lot.printing_id if lot else row.confirmed_printing_id
        for row, lot in rows
        if row.state == "COMMITTED"
    }
    cards = {
        card.id: card for card in db.scalars(select(Printing).where(Printing.id.in_(ids - {None})))
    }
    items, tokens = [], []
    counts = {scan.id: Counter() for scan in scans}
    for row, lot in rows:
        printing_id = lot.printing_id if lot else row.confirmed_printing_id
        tokens.append(
            (
                str(row.id),
                row.version,
                row.state,
                str(printing_id),
                lot.version if lot else None,
                row.id in used,
            )
        )
        if row.state == "IGNORED":
            continue
        if row.id in used:
            counts[row.scan_id]["already_added"] += 1
        elif row.state == "COMMITTED" and printing_id in cards:
            counts[row.scan_id]["ready"] += 1
            items.append(
                {
                    "observation_id": str(row.id),
                    "scan_id": str(row.scan_id),
                    "printing": printing_json(cards[printing_id]),
                    "section": "main",
                }
            )
        else:
            counts[row.scan_id]["pending"] += 1
    jobs = {job.scan_id: job for job in db.scalars(select(Job).where(Job.scan_id.in_(scan_ids)))}
    batches = [
        {
            "id": str(scan.id),
            "filename": scan.filename,
            "ready": counts[scan.id]["ready"],
            "pending": counts[scan.id]["pending"],
            "already_added": counts[scan.id]["already_added"],
            "processing": scan.id in jobs and jobs[scan.id].state in {"QUEUED", "RUNNING"},
        }
        for scan in scans
    ]
    return {
        "items": items,
        "batches": batches,
        "token": fingerprint(tokens),
        "deck_version": deck.version,
    }


@router.get("/batches")
def batches(
    identity: Identity,
    db: DB,
    deck_id: uuid.UUID,
    linked_only: bool = True,
    offset: int = Query(0, ge=0),
):
    owned(db, Deck, deck_id, identity.owner_id)
    query = select(Scan).where(
        Scan.owner_id == identity.owner_id, Scan.deleted_at.is_(None), Scan.accepted_at.is_not(None)
    )
    if linked_only:
        query = query.where(Scan.target_deck_id == deck_id)
    scans = list(
        db.scalars(query.order_by(Scan.created_at.desc(), Scan.id).offset(offset).limit(21))
    )
    ids = [scan.id for scan in scans[:20]]
    counts = Counter(
        dict(
            db.execute(
                select(Observation.scan_id, func.count())
                .where(Observation.scan_id.in_(ids), Observation.state != "IGNORED")
                .group_by(Observation.scan_id)
            ).all()
        )
    )
    added = Counter(
        dict(
            db.execute(
                select(Observation.scan_id, func.count())
                .join(DeckScanCard, DeckScanCard.observation_id == Observation.id)
                .where(Observation.scan_id.in_(ids), DeckScanCard.deck_id == deck_id)
                .group_by(Observation.scan_id)
            ).all()
        )
    )
    return {
        "items": [
            {
                "id": str(scan.id),
                "filename": scan.filename,
                "state": scan.state,
                "created_at": scan.created_at,
                "cards": counts[scan.id],
                "already_added": added[scan.id],
                "linked": scan.target_deck_id == deck_id,
                "thumbnail_url": f"/api/v1/scans/{scan.id}/image?kind=thumbnail"
                if scan.thumbnail_key
                else None,
            }
            for scan in scans[:20]
        ],
        "next_offset": offset + 20 if len(scans) > 20 else None,
    }


@router.post("/preview")
def preview(data: Preview, identity: Identity, db: DB):
    deck = owned(db, Deck, data.deck_id, identity.owner_id)
    return preview_data(db, identity.owner_id, deck, data.scan_ids)


@router.post("/save")
def save(data: Save, key: Key, identity: Identity, db: DB):
    # Worker/review/deletion paths take this same owner lock before changing scans.
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    deck = owned(db, Deck, data.deck_id, identity.owner_id, True)
    digest = fingerprint(data.model_dump())
    receipt = db.scalar(
        select(DeckScanCard).where(DeckScanCard.deck_id == deck.id, DeckScanCard.request_key == key)
    )
    if receipt:
        if receipt.request_hash != digest:
            raise HTTPException(409, "This request key belongs to different scanned cards.")
        return deck_detail(db, deck)
    if deck.archived or deck.version != data.expected_version:
        raise HTTPException(
            409, "This deck changed. Refresh the preview before adding scanned cards."
        )
    preview = preview_data(db, identity.owner_id, deck, data.scan_ids, lock=True)
    if preview["token"] != data.token:
        raise HTTPException(409, "These photo batches changed. Refresh the preview before saving.")
    if any(batch["processing"] for batch in preview["batches"]):
        raise HTTPException(
            409, "Wait for these photos to finish processing before adding their cards."
        )
    available = {item["observation_id"]: item for item in preview["items"]}
    if len({item.observation_id for item in data.items}) != len(data.items):
        raise HTTPException(422, "Select each scanned card only once.")
    additions = Counter()
    for item in data.items:
        source = available.get(str(item.observation_id))
        if not source:
            raise HTTPException(
                409, "A selected card needs review or is already in this deck. Refresh the preview."
            )
        additions[(uuid.UUID(source["printing"]["id"]), item.section)] += 1
    existing = {
        (card.printing_id, card.section): card
        for card in db.scalars(select(DeckCard).where(DeckCard.deck_id == deck.id))
    }
    if len(set(existing) | set(additions)) > 300:
        raise HTTPException(
            422, "A deck can contain at most 300 distinct printing/section entries."
        )
    for (printing_id, section), quantity in additions.items():
        card = existing.get((printing_id, section))
        if card:
            if card.quantity + quantity > 100_000:
                raise HTTPException(
                    422, "Combined quantities cannot exceed 100,000 per printing and section."
                )
            card.quantity += quantity
        else:
            db.add(
                DeckCard(
                    deck_id=deck.id, printing_id=printing_id, section=section, quantity=quantity
                )
            )
    for item in data.items:
        db.add(
            DeckScanCard(
                deck_id=deck.id,
                observation_id=item.observation_id,
                request_key=key,
                request_hash=digest,
            )
        )
    deck.version += 1
    deck.updated_at = now()
    db.commit()
    return deck_detail(db, deck)
