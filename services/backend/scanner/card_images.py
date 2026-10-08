"""Unmodified Scryfall card images, cached once per source URL in private storage."""

import hashlib
import uuid
from typing import Literal
from urllib.parse import urlparse

import httpx
from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy import or_, select, text

from scanner import storage
from scanner.auth import DB, Identity
from scanner.db import session_factory
from scanner.models import (
    Deck,
    DeckCard,
    Friendship,
    InventoryLot,
    Observation,
    Printing,
    Scan,
    TradeOffer,
    TradeOfferCard,
    User,
    WishlistItem,
)

router = APIRouter(prefix="/api/v1/card-images", tags=["card images"])


def source_image(card, face, size):
    raw = card.source_json
    faces = raw.get("card_faces") or []
    images = (
        (raw.get("image_uris") if face == 0 else None)
        or (faces[face].get("image_uris") if face < len(faces) else None)
        or {}
    )
    keys = (
        ("art_crop", "normal", "small")
        if size == "art"
        else ("grid", "normal", "small")
        if size == "grid"
        else ("display", "normal", "large")
    )
    url = next((images[key] for key in keys if images.get(key)), None)
    if not isinstance(url, str):
        return None
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "cards.scryfall.io"
        or str(card.id) not in parsed.path
        or not parsed.path.endswith((".jpg", ".png", ".webp"))
    ):
        return None
    return url


def cached(key):
    try:
        obj = storage.get(key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    try:
        return obj["Body"].read(), obj["ContentType"]
    finally:
        obj["Body"].close()


@router.get("/related/{source_id}/{printing_id}/{face}/{size}")
def related_token_image(
    source_id: uuid.UUID,
    printing_id: uuid.UUID,
    face: int,
    size: Literal["grid", "detail"],
    identity: Identity,
    db: DB,
):
    from scanner.deck_tokens import linked_tokens

    # Draft decks may reference unowned cards. Only their catalog-linked tokens
    # are accessible here, with the same allowlisted image cache as saved cards.
    source = db.get(Printing, source_id)
    if face not in {0, 1} or not source or printing_id not in linked_tokens(source):
        raise HTTPException(404, "Token image not found.")
    card = db.get(Printing, printing_id)
    if not card:
        raise HTTPException(404, "Token image not found.")
    db.expunge(card)
    db.rollback()
    data, content_type, digest = load_image(card, face, size)
    return Response(
        data,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": '"' + digest + '"',
        },
    )


def shared_by_friend(db, owner_id, printing_id):
    """A card a connected friend shows this account: in their collection or on
    their wishlist, only while they share that part and are not suspended."""
    friends = (
        select(User.id, User.share_collection, User.share_wishlist)
        .join(
            Friendship,
            or_(
                (Friendship.user_a == owner_id) & (Friendship.user_b == User.id),
                (Friendship.user_b == owner_id) & (Friendship.user_a == User.id),
            ),
        )
        .where(Friendship.state == "accepted", User.suspended.is_(False))
        .subquery()
    )
    return db.scalar(
        select(friends.c.id)
        .where(
            or_(
                friends.c.share_collection
                & select(InventoryLot.id)
                .where(
                    InventoryLot.owner_id == friends.c.id,
                    InventoryLot.printing_id == printing_id,
                    InventoryLot.quantity_remaining > 0,
                )
                .exists(),
                friends.c.share_wishlist
                & select(WishlistItem.id)
                .where(
                    WishlistItem.owner_id == friends.c.id,
                    WishlistItem.printing_id == printing_id,
                )
                .exists(),
            )
        )
        .limit(1)
    )


@router.get("/{printing_id}/{face}/{size}")
def card_image(
    printing_id: uuid.UUID,
    face: int,
    size: Literal["grid", "detail", "art"],
    identity: Identity,
    db: DB,
):
    owned = (
        db.scalar(
            select(InventoryLot.id)
            .where(
                InventoryLot.owner_id == identity.owner_id,
                InventoryLot.printing_id == printing_id,
                InventoryLot.quantity_remaining > 0,
            )
            .limit(1)
        )
        or db.scalar(
            select(Observation.id)
            .join(Scan)
            .where(
                Scan.owner_id == identity.owner_id,
                Scan.deleted_at.is_(None),
                Observation.recognition["candidates"].contains([{"printing_id": str(printing_id)}]),
            )
            .limit(1)
        )
        or db.scalar(
            select(DeckCard.deck_id)
            .join(Deck)
            .where(
                Deck.owner_id == identity.owner_id,
                Deck.archived.is_(False),
                DeckCard.printing_id == printing_id,
            )
            .limit(1)
        )
        or db.scalar(
            select(WishlistItem.id)
            .where(
                WishlistItem.owner_id == identity.owner_id,
                WishlistItem.printing_id == printing_id,
            )
            .limit(1)
        )
        or db.scalar(
            select(TradeOfferCard.offer_id)
            .join(TradeOffer)
            .where(
                or_(
                    TradeOffer.sender_id == identity.owner_id,
                    TradeOffer.recipient_id == identity.owner_id,
                ),
                TradeOfferCard.printing_id == printing_id,
            )
            .limit(1)
        )
        or shared_by_friend(db, identity.owner_id, printing_id)
    )
    if face not in {0, 1} or not owned:
        raise HTTPException(404, "Card image not found.")
    card = db.get(Printing, printing_id)
    # Detach before releasing the authorization connection (avoid another query).
    db.expunge(card)
    db.rollback()
    data, content_type, digest = load_image(card, face, size)
    return Response(
        data,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": '"' + digest + '"',
        },
    )


def load_image(card, face=0, size="grid", timeout=15):
    """Shared display/reference cache; only allowlisted catalog CDN URLs."""
    url = source_image(card, face, size)
    if not url:
        raise HTTPException(404, "Artwork is not available for this printing.")
    digest = hashlib.sha256(url.encode()).hexdigest()
    key = f"catalog-images/{card.id}/{digest}"
    # Release the authorization query's connection before taking a cache-miss
    # lock. A page of images must not each hold one pool slot while awaiting two.
    obj = cached(key)
    if obj is None:
        # Serialize only cache misses for this image across API processes. The
        # CDN has no API request limit; browsing never calls api.scryfall.com.
        engine = session_factory().kw["bind"]
        lock_id = int(digest[:15], 16)
        with engine.begin() as lock:
            lock.execute(text("SET LOCAL lock_timeout = '3s'"))
            lock.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": lock_id})
            obj = cached(key)
            if obj is None:
                try:
                    with (
                        httpx.Client(
                            timeout=timeout,
                            follow_redirects=False,
                            headers={
                                "User-Agent": "PakTrak/0.1 (collection card image cache)",
                                "Accept": "image/webp,image/jpeg,image/png",
                            },
                        ) as client,
                        client.stream("GET", url) as response,
                    ):
                        response.raise_for_status()
                        content_type = response.headers.get("Content-Type", "").split(";")[0]
                        if content_type not in {"image/jpeg", "image/png", "image/webp"}:
                            raise ValueError("Unsupported image")
                        data = bytearray()
                        for chunk in response.iter_bytes(64 * 1024):
                            data.extend(chunk)
                            if len(data) > 4 * 1024**2:
                                raise ValueError("Image too large")
                        if not data:
                            raise ValueError("Empty image")
                        storage.put(key, bytes(data), content_type)
                        obj = bytes(data), content_type
                except (httpx.HTTPError, ValueError):
                    raise HTTPException(
                        503, "Artwork is temporarily unavailable.", headers={"Retry-After": "60"}
                    ) from None
    return obj[0], obj[1], digest
