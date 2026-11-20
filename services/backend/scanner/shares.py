"""Read-only links to one deck or to the wishlist, for people without an account.

A link exists only after its owner creates it, shows the card list and nothing
else (no account name, notes, prices, storage locations or collection), and
stops working the moment it is turned off.
"""

import secrets
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select

from scanner.auth import DB, Identity
from scanner.card_images import load_image
from scanner.catalog import printing_json
from scanner.models import Deck, DeckCard, Printing, ShareLink, User, WishlistItem

router = APIRouter(prefix="/api/v1/shares", tags=["share links"])
public = APIRouter(prefix="/api/public/shares", tags=["share links"])

MAX_LINKS = 200
NOT_FOUND = "This link isn’t active. Ask the person who sent it for a new one."
SECTIONS = {"commander": 0, "main": 1, "sideboard": 2}
PRIVATE = {"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow"}


class NewLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["deck", "wishlist"]
    deck_id: uuid.UUID | None = None


def link_json(link):
    return {
        "id": str(link.id),
        "kind": link.kind,
        "deck_id": str(link.deck_id) if link.deck_id else None,
        "token": link.token,
        "created_at": link.created_at,
    }


@router.get("")
def links(identity: Identity, db: DB):
    rows = db.scalars(
        select(ShareLink)
        .where(ShareLink.owner_id == identity.owner_id)
        .order_by(ShareLink.created_at)
    )
    return {"items": [link_json(link) for link in rows]}


@router.post("", status_code=201)
def create_link(data: NewLink, identity: Identity, db: DB):
    """Create the link, or return the one already made for this deck or wishlist."""
    if (data.kind == "deck") != (data.deck_id is not None):
        raise HTTPException(422, "Choose the deck to share.")
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    if data.deck_id and not db.scalar(
        select(Deck.id).where(
            Deck.id == data.deck_id, Deck.owner_id == identity.owner_id, Deck.archived.is_(False)
        )
    ):
        raise HTTPException(404, "Deck not found.")
    existing = db.scalar(
        select(ShareLink).where(
            ShareLink.owner_id == identity.owner_id,
            ShareLink.kind == data.kind,
            ShareLink.deck_id == data.deck_id if data.deck_id else ShareLink.deck_id.is_(None),
        )
    )
    if existing:
        return link_json(existing)
    count = db.scalar(
        select(func.count()).select_from(ShareLink).where(ShareLink.owner_id == identity.owner_id)
    )
    if count >= MAX_LINKS:
        raise HTTPException(422, "Turn off a share link you no longer need first.")
    link = ShareLink(
        owner_id=identity.owner_id,
        kind=data.kind,
        deck_id=data.deck_id,
        token=secrets.token_urlsafe(32),
    )
    db.add(link)
    db.commit()
    return link_json(link)


@router.delete("/{link_id}")
def remove_link(link_id: uuid.UUID, identity: Identity, db: DB):
    link = db.scalar(
        select(ShareLink).where(ShareLink.id == link_id, ShareLink.owner_id == identity.owner_id)
    )
    if link:
        db.delete(link)
        db.commit()
    return {"removed": True}


def active_link(db, token):
    """The link for a token, while its owner's account is in good standing."""
    link = (
        db.scalar(
            select(ShareLink)
            .join(User, User.id == ShareLink.owner_id)
            .where(ShareLink.token == token, User.suspended.is_(False))
        )
        if 20 <= len(token) <= 64
        else None
    )
    if link is None:
        raise HTTPException(404, NOT_FOUND)
    return link


def shared_rows(db, link):
    """(printing, quantity, section or finish) for everything the link shows."""
    if link.kind == "deck":
        deck = db.get(Deck, link.deck_id)
        if deck is None or deck.archived:
            raise HTTPException(404, NOT_FOUND)
        rows = db.execute(
            select(Printing, DeckCard.quantity, DeckCard.section)
            .join(DeckCard, DeckCard.printing_id == Printing.id)
            .where(DeckCard.deck_id == deck.id)
            .order_by(Printing.name, Printing.id)
        ).all()
        return deck, sorted(rows, key=lambda row: SECTIONS.get(row[2], 9))
    rows = db.execute(
        select(Printing, WishlistItem.quantity, WishlistItem.finish)
        .join(WishlistItem, WishlistItem.printing_id == Printing.id)
        .where(WishlistItem.owner_id == link.owner_id)
        .order_by(func.lower(Printing.name), Printing.set_code, WishlistItem.finish)
    ).all()
    return None, rows


@public.get("/{token}")
def shared(token: str, db: DB, response: Response):
    link = active_link(db, token)
    deck, rows = shared_rows(db, link)
    response.headers.update(PRIVATE)

    def card(printing):
        data = printing_json(printing)
        if data.get("image_url"):
            data["image_url"] = f"/api/public/shares/{token}/images/{printing.id}"
        return data

    if deck:
        return {
            "kind": "deck",
            "name": deck.name,
            "format": deck.format,
            "copies": sum(quantity for _, quantity, _ in rows),
            "cards": [
                {"printing": card(printing), "quantity": quantity, "section": section}
                for printing, quantity, section in rows
            ],
        }
    return {
        "kind": "wishlist",
        "copies": sum(quantity for _, quantity, _ in rows),
        "cards": [
            {"printing": card(printing), "quantity": quantity, "finish": finish}
            for printing, quantity, finish in rows
        ],
    }


@public.get("/{token}/images/{printing_id}")
def shared_image(token: str, printing_id: uuid.UUID, db: DB):
    """Card art for a card on the shared list, and for no other card."""
    link = active_link(db, token)
    if link.kind == "deck":
        listed = select(DeckCard.printing_id).where(
            DeckCard.deck_id == link.deck_id, DeckCard.printing_id == printing_id
        )
        deck = db.get(Deck, link.deck_id)
        if deck is None or deck.archived:
            raise HTTPException(404, NOT_FOUND)
    else:
        listed = select(WishlistItem.printing_id).where(
            WishlistItem.owner_id == link.owner_id, WishlistItem.printing_id == printing_id
        )
    if not db.scalar(listed.limit(1)):
        raise HTTPException(404, "Card image not found.")
    card = db.get(Printing, printing_id)
    # Detach before releasing the authorization connection, as signed-in card art does.
    db.expunge(card)
    db.rollback()
    data, content_type, digest = load_image(card, 0, "grid")
    return Response(
        data,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=86400", "ETag": '"' + digest + '"'},
    )
