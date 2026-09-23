"""Collection discovery, cached provider prices and complete card details."""

import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException
from sqlalchemy import String, and_, func, literal_column, or_, select, true

from scanner.auth import DB, Identity
from scanner.card_search import split_collector_search
from scanner.catalog import printing_json
from scanner.data_sync import FEEDS, PROVIDERS, trusted_url
from scanner.models import Binder, CardPrice, DataFeed, InventoryLot, Printing, now

router = APIRouter(prefix="/api/v1", tags=["gallery"])
Provider = Literal["tcgplayer", "cardkingdom", "manapool"]
Sort = Literal["name", "price", "price_asc", "price_desc", "quantity", "newest", "mana", "shuffle"]


def feed_json(feed):
    return {
        "name": feed.name,
        "state": feed.state,
        "progress": feed.progress,
        "updated_at": feed.updated_at,
        "checked_at": feed.checked_at,
        "source_time": feed.source_time,
        "next_at": feed.next_at,
        "records": feed.records,
        "error": feed.error,
        "stale": not feed.updated_at or feed.updated_at < now() - timedelta(hours=48),
    }


@router.get("/data/status")
def data_status(identity: Identity, db: DB):
    feeds = {feed.name: feed_json(feed) for feed in db.scalars(select(DataFeed))}
    return {
        "feeds": [
            feeds.get(name, {"name": name, "state": "WAITING", "progress": {}, "stale": True})
            for name in FEEDS
        ],
        "providers": PROVIDERS,
    }


def collection_cards(
    db,
    owner_id,
    *,
    offset,
    binder_id,
    q,
    provider,
    color,
    rarity,
    card_type,
    set_code,
    finish,
    sort,
    seed,
    min_price=None,
    max_price=None,
):
    condition = [InventoryLot.owner_id == owner_id, InventoryLot.quantity_remaining > 0]
    if binder_id:
        if not db.scalar(
            select(Binder.id).where(Binder.id == binder_id, Binder.owner_id == owner_id)
        ):
            raise HTTPException(404, "Collection resource not found.")
        condition.append(InventoryLot.binder_id == binder_id)
    search_text, collector_number = split_collector_search(q)
    if search_text:
        # Rules text searches include both faces without downloading the catalog.
        condition.append(
            or_(
                Printing.name.icontains(search_text, autoescape=True),
                Printing.source_json["oracle_text"].astext.icontains(search_text, autoescape=True),
                func.jsonb_path_query_array(
                    Printing.source_json, literal_column("'$.card_faces[*].oracle_text'::jsonpath")
                )
                .cast(String)
                .icontains(search_text, autoescape=True),
            )
        )
    if collector_number:
        condition.append(func.lower(Printing.collector_number) == collector_number.lower())
    if color:
        colors = Printing.source_json["color_identity"]
        if color == "C":
            condition.append(colors == [])
        elif color == "M":
            condition.append(func.jsonb_array_length(colors) > 1)
        else:
            condition.append(colors.contains([color]))
    if rarity:
        condition.append(Printing.source_json["rarity"].astext == rarity)
    if card_type:
        condition.append(
            Printing.source_json["type_line"].astext.icontains(card_type, autoescape=True)
        )
    if set_code:
        condition.append(Printing.set_code == set_code.lower())
    if finish:
        condition.append(InventoryLot.finish == finish)
    priced = and_(
        CardPrice.amount.is_not(None),
        InventoryLot.misprint.is_not(True),
        InventoryLot.altered.is_not(True),
    )
    if min_price is not None or max_price is not None:
        # Apply the selected provider's per-copy price to owned finishes before
        # grouping and pagination. An absent quote is never treated as zero.
        condition.append(priced)
        if min_price is not None:
            condition.append(CardPrice.amount >= min_price)
        if max_price is not None:
            condition.append(CardPrice.amount <= max_price)
    issues = {
        "unknown_finish": and_(
            InventoryLot.finish == "unknown",
            InventoryLot.misprint.is_not(True),
            InventoryLot.altered.is_not(True),
        ),
        "custom_value": or_(InventoryLot.misprint.is_(True), InventoryLot.altered.is_(True)),
    }
    holdings = (
        select(
            InventoryLot.printing_id,
            InventoryLot.binder_id,
            func.sum(InventoryLot.quantity_remaining).label("quantity"),
            func.sum(InventoryLot.quantity_remaining * CardPrice.amount)
            .filter(priced)
            .label("value"),
            func.coalesce(func.sum(InventoryLot.quantity_remaining).filter(priced), 0).label(
                "priced_copies"
            ),
            func.min(CardPrice.amount).filter(priced).label("price_min"),
            func.max(CardPrice.amount).filter(priced).label("price_max"),
            func.max(InventoryLot.created_at).label("added_at"),
            *(
                func.coalesce(func.sum(InventoryLot.quantity_remaining).filter(condition), 0).label(
                    name
                )
                for name, condition in issues.items()
            ),
        )
        .select_from(InventoryLot)
        .join(Printing, Printing.id == InventoryLot.printing_id)
        .outerjoin(
            CardPrice,
            and_(
                CardPrice.printing_id == InventoryLot.printing_id,
                CardPrice.finish == InventoryLot.finish,
                CardPrice.provider == provider,
            ),
        )
        .where(*condition)
        .group_by(InventoryLot.printing_id, InventoryLot.binder_id)
        .cte("holdings")
    )
    totals = (
        select(
            holdings.c.printing_id,
            func.sum(holdings.c.quantity).label("quantity"),
            func.count().label("location_count"),
            func.sum(holdings.c.value).label("value"),
            func.sum(holdings.c.priced_copies).label("priced_copies"),
            func.min(holdings.c.price_min).label("price_min"),
            func.max(holdings.c.price_max).label("price_max"),
            func.max(holdings.c.added_at).label("added_at"),
            *(func.sum(holdings.c[name]).label(name) for name in issues),
        )
        .group_by(holdings.c.printing_id)
        .cte("totals")
    )

    def ordering(table):
        prefix = {
            "price": [table.c.price_max.desc().nulls_last()],
            "price_asc": [table.c.price_min.asc().nulls_last()],
            "price_desc": [table.c.price_max.desc().nulls_last()],
            "quantity": [table.c.quantity.desc()],
            "newest": [table.c.added_at.desc()],
            "mana": [Printing.source_json["cmc"].as_float().asc().nulls_last()],
            "shuffle": [func.md5(Printing.id.cast(String) + seed)],
        }.get(sort, [])
        return (*prefix, Printing.name, Printing.set_code, Printing.collector_number, Printing.id)

    page = (
        select(totals)
        .join(Printing, Printing.id == totals.c.printing_id)
        .order_by(*ordering(totals))
        .offset(offset)
        .limit(41)
        .cte("card_page")
    )
    summary = select(
        func.coalesce(func.sum(totals.c.quantity), 0).label("copies"),
        func.count().label("cards"),
        func.sum(totals.c.value).label("total_value"),
        func.coalesce(func.sum(totals.c.priced_copies), 0).label("total_priced"),
        *(func.coalesce(func.sum(totals.c[name]), 0).label("total_" + name) for name in issues),
    ).cte("card_summary")
    locations = (
        select(
            holdings.c.printing_id,
            holdings.c.binder_id,
            holdings.c.quantity,
            Binder.name,
            Binder.kind,
            func.row_number()
            .over(partition_by=holdings.c.printing_id, order_by=(Binder.name, Binder.id))
            .label("position"),
        )
        .join(page, page.c.printing_id == holdings.c.printing_id)
        .join(Binder, Binder.id == holdings.c.binder_id)
        .cte("card_locations")
    )
    rows = db.execute(
        select(
            Printing,
            page.c.quantity,
            page.c.location_count,
            page.c.value,
            page.c.priced_copies,
            page.c.price_min,
            page.c.price_max,
            *(page.c[name] for name in issues),
            summary.c.copies,
            summary.c.cards,
            summary.c.total_value,
            summary.c.total_priced,
            *(summary.c["total_" + name] for name in issues),
            locations.c.binder_id,
            locations.c.name,
            locations.c.kind,
            locations.c.quantity.label("location_quantity"),
        )
        .select_from(summary)
        .outerjoin(page, true())
        .outerjoin(Printing, Printing.id == page.c.printing_id)
        .outerjoin(
            locations,
            and_(locations.c.printing_id == page.c.printing_id, locations.c.position <= 3),
        )
        .order_by(*ordering(page), locations.c.position)
    ).all()
    cards = {}
    for row in rows:
        printing = row[0]
        if printing is None:
            continue
        card = cards.setdefault(
            printing.id,
            {
                "printing": printing_json(printing),
                "quantity": int(row.quantity),
                "location_count": row.location_count,
                "locations": [],
                "value": str(row.value) if row.value is not None else None,
                "priced_copies": int(row.priced_copies),
                "price_min": str(row.price_min) if row.price_min is not None else None,
                "price_max": str(row.price_max) if row.price_max is not None else None,
                "pricing_issues": {
                    "unknown_finish": int(row.unknown_finish),
                    "custom_value": int(row.custom_value),
                    "missing_price": int(
                        row.quantity - row.priced_copies - row.unknown_finish - row.custom_value
                    ),
                },
            },
        )
        card["locations"].append(
            {
                "id": str(row.binder_id),
                "name": row.name,
                "kind": row.kind,
                "quantity": int(row.location_quantity),
            }
        )
    first = rows[0]
    feed = db.get(DataFeed, PROVIDERS[provider]["feed"])
    return {
        "copies": int(first.copies),
        "cards": first.cards,
        "items": list(cards.values())[:40],
        "next_offset": offset + 40 if len(cards) > 40 else None,
        "valuation": {
            "provider": provider,
            "amount": str(first.total_value) if first.total_value is not None else None,
            "priced_copies": int(first.total_priced),
            "unpriced_copies": int(first.copies - first.total_priced),
            "pricing_issues": {
                "unknown_finish": int(first.total_unknown_finish),
                "custom_value": int(first.total_custom_value),
                "missing_price": int(
                    first.copies
                    - first.total_priced
                    - first.total_unknown_finish
                    - first.total_custom_value
                ),
            },
            "feed": feed_json(feed) if feed else None,
        },
    }


@router.get("/collection/filters")
def filters(identity: Identity, db: DB):
    sets = db.execute(
        select(Printing.set_code, func.max(Printing.source_json["set_name"].astext))
        .join(InventoryLot)
        .where(InventoryLot.owner_id == identity.owner_id, InventoryLot.quantity_remaining > 0)
        .group_by(Printing.set_code)
        .order_by(Printing.set_code)
    ).all()
    return {"sets": [{"code": code, "name": name or code.upper()} for code, name in sets]}


@router.get("/collection/printings/{printing_id}")
def card_detail(printing_id: uuid.UUID, identity: Identity, db: DB):
    if not db.scalar(
        select(InventoryLot.id)
        .where(
            InventoryLot.owner_id == identity.owner_id,
            InventoryLot.printing_id == printing_id,
            InventoryLot.quantity_remaining > 0,
        )
        .limit(1)
    ):
        raise HTTPException(404, "This card is not in your collection.")
    card = db.get(Printing, printing_id)
    raw = card.source_json
    feeds = {feed.name: feed_json(feed) for feed in db.scalars(select(DataFeed))}
    prices = db.scalars(select(CardPrice).where(CardPrice.printing_id == printing_id)).all()
    fields = (
        "name",
        "mana_cost",
        "type_line",
        "oracle_text",
        "flavor_text",
        "power",
        "toughness",
        "loyalty",
        "defense",
        "artist",
    )
    faces = raw.get("card_faces") or [raw]
    return {
        "printing": printing_json(card),
        "faces": [
            {
                **{key: face.get(key) for key in fields},
                "image_url": image_url(card, index, "detail"),
            }
            for index, face in enumerate(faces)
        ],
        "legalities": raw.get("legalities", {}),
        "released_at": raw.get("released_at"),
        "scryfall_url": trusted_url(raw.get("scryfall_uri"), "scryfall.com"),
        "prices": [
            {
                "provider": provider,
                **config,
                "feed": feeds.get(config["feed"]),
                "finishes": [
                    {
                        "finish": price.finish,
                        "amount": str(price.amount),
                        "url": price.url,
                        "available": price.available,
                    }
                    for price in prices
                    if price.provider == provider
                ],
            }
            for provider, config in PROVIDERS.items()
        ],
    }


def image_url(card, face=0, size="grid"):
    from scanner.card_images import source_image

    return (
        f"/api/v1/card-images/{card.id}/{face}/{size}" if source_image(card, face, size) else None
    )
