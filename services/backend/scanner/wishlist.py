"""Wishlists: cards an account wants, priced from the local cache and never owned copies."""

import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field
from sqlalchemy import func, select

from scanner.auth import DB, Identity
from scanner.card_values import finish_prices, money, owned_by_name, preferred_provider, unit_price
from scanner.catalog import printing_json
from scanner.collection_api import StrictModel, owned
from scanner.deck_lists import MAX_DECK_BYTES, preview_list
from scanner.gallery import Provider
from scanner.models import ImportBatch, ImportRow, Printing, User, WishlistItem, now

router = APIRouter(prefix="/api/v1/wishlist", tags=["wishlist"])
MAX_ITEMS = 2000
WISHLIST_TYPES = {"wishlist", "wish list", "list"}
WantedFinish = Literal["any", "nonfoil", "foil", "etched"]


class WantedCard(StrictModel):
    printing_id: uuid.UUID
    finish: WantedFinish = "any"
    quantity: int = Field(default=1, ge=1, le=999, strict=True)
    notes: str = Field(default="", max_length=500)


class WantedCards(StrictModel):
    items: list[WantedCard] = Field(min_length=1, max_length=300)


class WantedEdit(StrictModel):
    quantity: int = Field(ge=1, le=999, strict=True)
    finish: WantedFinish
    notes: str = Field(default="", max_length=500)


class WantedList(StrictModel):
    content: str = Field(min_length=1, max_length=MAX_DECK_BYTES)


def wishlist_json(db, owner_id, provider, viewer_id=None):
    """Owned counts are the viewer's, so a friend sees how many they could offer."""
    rows = db.execute(
        select(WishlistItem, Printing)
        .join(Printing)
        .where(WishlistItem.owner_id == owner_id)
        .order_by(func.lower(Printing.name), Printing.set_code, WishlistItem.finish)
    ).all()
    prices = finish_prices(db, provider, {printing.id for _, printing in rows})
    have = owned_by_name(db, viewer_id or owner_id, {printing.name for _, printing in rows})
    items, total, priced, copies = [], Decimal(0), 0, 0
    for item, printing in rows:
        finish, amount = unit_price(prices, printing, item.finish)
        copies += item.quantity
        if amount is not None:
            total += amount * item.quantity
            priced += item.quantity
        items.append(
            {
                "id": str(item.id),
                "printing": printing_json(printing),
                "finish": item.finish,
                "quantity": item.quantity,
                "notes": item.notes,
                "price_finish": finish,
                "unit_amount": money(amount),
                "owned": have[printing.name.lower()],
                "created_at": item.created_at,
            }
        )
    return {
        "provider": provider,
        "items": items,
        "copies": copies,
        "priced_copies": priced,
        "amount": money(total) if priced or not copies else None,
    }


def add_items(db, owner_id, cards):
    """Add wanted copies, merging repeats. Returns the number of copies added."""
    # One writer per account at a time, so repeats merge instead of colliding.
    db.scalar(select(User.id).where(User.id == owner_id).with_for_update())
    ids = {card.printing_id for card in cards}
    known = set(db.scalars(select(Printing.id).where(Printing.id.in_(ids))))
    if known != ids:
        raise HTTPException(422, "Every wanted card must have a printing in this server's catalog.")
    existing = {
        (item.printing_id, item.finish): item
        for item in db.scalars(
            select(WishlistItem)
            .where(WishlistItem.owner_id == owner_id, WishlistItem.printing_id.in_(ids))
            .with_for_update()
        )
    }
    count = db.scalar(
        select(func.count()).select_from(WishlistItem).where(WishlistItem.owner_id == owner_id)
    )
    added = 0
    for card in cards:
        item = existing.get((card.printing_id, card.finish))
        if item is None:
            if count >= MAX_ITEMS:
                raise HTTPException(
                    422, f"A wishlist can hold up to {MAX_ITEMS:,} different cards."
                )
            item = WishlistItem(
                owner_id=owner_id,
                printing_id=card.printing_id,
                finish=card.finish,
                quantity=0,
                notes=card.notes,
                created_at=now(),
            )
            db.add(item)
            existing[(card.printing_id, card.finish)] = item
            count += 1
        before = item.quantity
        item.quantity = min(999, before + card.quantity)
        added += item.quantity - before
    db.flush()
    return added


@router.get("")
def wishlist(identity: Identity, db: DB, provider: Provider | None = None):
    return wishlist_json(
        db, identity.owner_id, provider or preferred_provider(db, identity.owner_id)
    )


@router.post("")
def add_cards(data: WantedCards, identity: Identity, db: DB):
    added = add_items(db, identity.owner_id, data.items)
    db.commit()
    return {"added": added}


@router.post("/paste")
def add_list(data: WantedList, identity: Identity, db: DB):
    try:
        preview = preview_list(db, data.content, "text")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    cards = [
        WantedCard(printing_id=row["printing"]["id"], quantity=min(999, row["quantity"]))
        for row in preview["items"]
        if row["printing"] and not row["error"]
    ]
    added = add_items(db, identity.owner_id, cards) if cards else 0
    db.commit()
    return {
        "added": added,
        "unresolved": [
            {"line": row["line"], "name": row["name"], "error": row["error"]}
            for row in preview["items"]
            if not row["printing"] or row["error"]
        ],
    }


@router.post("/from-import/{import_id}")
def add_import_wishlist(import_id: uuid.UUID, identity: Identity, db: DB):
    """Wishlist rows are skipped by collection imports; this adds them here instead."""
    batch = owned(db, ImportBatch, import_id, identity.owner_id)
    rows = db.scalars(
        select(ImportRow).where(
            ImportRow.import_id == batch.id,
            ImportRow.state == "SKIPPED",
            ImportRow.printing_id.is_not(None),
        )
    ).all()
    cards = [
        WantedCard(
            printing_id=row.printing_id,
            quantity=min(999, max(1, row.quantity or 1)),
            finish=row.normalized.get("finish")
            if row.normalized.get("finish") in ("nonfoil", "foil", "etched")
            else "any",
        )
        for row in rows
        if str(row.normalized.get("binder_type", "")).lower() in WISHLIST_TYPES
    ]
    if not cards:
        raise HTTPException(409, "This import has no wishlist cards that match the catalog.")
    added = add_items(db, identity.owner_id, cards)
    db.commit()
    return {"added": added}


@router.post("/{item_id}")
def edit_item(item_id: uuid.UUID, data: WantedEdit, identity: Identity, db: DB):
    item = owned(db, WishlistItem, item_id, identity.owner_id, True)
    twin = None
    if data.finish != item.finish:
        twin = db.scalar(
            select(WishlistItem)
            .where(
                WishlistItem.owner_id == identity.owner_id,
                WishlistItem.printing_id == item.printing_id,
                WishlistItem.finish == data.finish,
            )
            .with_for_update()
        )
    if twin:
        # Changing to a finish already listed combines the two entries.
        twin.quantity = min(999, twin.quantity + data.quantity)
        twin.notes = data.notes or twin.notes
        db.delete(item)
    else:
        item.quantity, item.finish, item.notes = data.quantity, data.finish, data.notes
    db.commit()
    return {"id": str((twin or item).id)}


@router.delete("/{item_id}")
def remove_item(item_id: uuid.UUID, identity: Identity, db: DB):
    db.delete(owned(db, WishlistItem, item_id, identity.owner_id, True))
    db.commit()
    return {"removed": True}
