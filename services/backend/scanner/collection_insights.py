"""Collection value over time, card price history, set completion and deck usage."""

import re
import uuid
from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import and_, func, select

from scanner.auth import DB, Identity
from scanner.card_values import finish_prices, money, preferred_provider, unit_price
from scanner.catalog import printing_json
from scanner.deck_lists import deck_usage
from scanner.gallery import Provider
from scanner.models import (
    Binder,
    CardPrice,
    CardPriceHistory,
    CollectionValueHistory,
    InventoryLot,
    Printing,
    WishlistItem,
)

router = APIRouter(prefix="/api/v1/collection", tags=["collection insights"])


def live_value(db, owner_id, provider):
    """Today's total from the current cache, using the same rules as the collection page."""
    priced = and_(
        CardPrice.amount.is_not(None),
        InventoryLot.misprint.is_not(True),
        InventoryLot.altered.is_not(True),
    )
    row = db.execute(
        select(
            func.sum(InventoryLot.quantity_remaining * CardPrice.amount).filter(priced),
            func.coalesce(func.sum(InventoryLot.quantity_remaining).filter(priced), 0),
            func.coalesce(func.sum(InventoryLot.quantity_remaining), 0),
        )
        .select_from(InventoryLot)
        .outerjoin(
            CardPrice,
            and_(
                CardPrice.printing_id == InventoryLot.printing_id,
                CardPrice.finish == InventoryLot.finish,
                CardPrice.provider == provider,
            ),
        )
        .where(InventoryLot.owner_id == owner_id, InventoryLot.quantity_remaining > 0)
    ).one()
    return row[0] or Decimal(0), int(row[1]), int(row[2])


def change(points):
    if len(points) < 2:
        return None
    first, last = Decimal(points[0]["amount"]), Decimal(points[-1]["amount"])
    return {
        "amount": money(last - first),
        "percent": round(float((last - first) / first * 100), 1) if first else None,
        "since": points[0]["day"],
    }


@router.get("/value-history")
def value_history(
    identity: Identity,
    db: DB,
    provider: Provider | None = None,
    days: int = Query(90, ge=7, le=366),
):
    provider = provider or preferred_provider(db, identity.owner_id)
    today = date.today()
    rows = db.scalars(
        select(CollectionValueHistory)
        .where(
            CollectionValueHistory.owner_id == identity.owner_id,
            CollectionValueHistory.provider == provider,
            CollectionValueHistory.day >= today - timedelta(days=days),
            CollectionValueHistory.day < today,
        )
        .order_by(CollectionValueHistory.day)
    ).all()
    points = [
        {
            "day": row.day.isoformat(),
            "amount": money(Decimal(row.amount)),
            "priced_copies": row.priced_copies,
            "copies": row.copies,
        }
        for row in rows
    ]
    amount, priced, copies = live_value(db, identity.owner_id, provider)
    # An emptied collection still gets today's zero once it has history to compare with.
    if copies or points:
        points.append(
            {
                "day": today.isoformat(),
                "amount": money(amount),
                "priced_copies": priced,
                "copies": copies,
            }
        )
    return {"provider": provider, "days": days, "points": points, "change": change(points)}


COLOR_NAMES = {"W": "White", "U": "Blue", "B": "Black", "R": "Red", "G": "Green"}
COLOR_ORDER = ["White", "Blue", "Black", "Red", "Green", "Multicolor", "Colorless"]
RARITY_ORDER = ["mythic", "rare", "uncommon", "common", "special", "bonus"]
# A card with several types counts once, under the first of these on its type line.
TYPE_ORDER = [
    "Land",
    "Creature",
    "Planeswalker",
    "Battle",
    "Instant",
    "Sorcery",
    "Artifact",
    "Enchantment",
]


def color_group(identity):
    colors = [color for color in identity or [] if color in COLOR_NAMES]
    if len(colors) > 1:
        return "Multicolor"
    return COLOR_NAMES[colors[0]] if colors else "Colorless"


def type_group(type_line):
    front = (type_line or "").split("//")[0]
    return next((name for name in TYPE_ORDER if name in front), "Other")


class Tally:
    """Copies and value per group, in the order a group was first seen."""

    def __init__(self):
        self.rows = {}

    def add(self, key, label, copies, value):
        row = self.rows.setdefault(key, {"key": key, "label": label, "copies": 0, "value": None})
        row["copies"] += copies
        if value is not None:
            row["value"] = (row["value"] or Decimal(0)) + value

    def listed(self, order=None, limit=None):
        rows = list(self.rows.values())
        if order:
            rows.sort(key=lambda row: order.index(row["key"]) if row["key"] in order else 99)
        else:
            rows.sort(key=lambda row: (-(row["value"] or 0), -row["copies"], row["label"]))
        if limit and len(rows) > limit:
            rest = rows[limit:]
            values = [row["value"] for row in rest if row["value"] is not None]
            rows = rows[:limit] + [
                {
                    "key": "",
                    "label": f"{len(rest)} more",
                    "copies": sum(row["copies"] for row in rest),
                    "value": sum(values, Decimal(0)) if values else None,
                }
            ]
        return [{**row, "value": money(row["value"])} for row in rows]


@router.get("/breakdown")
def breakdown(identity: Identity, db: DB, provider: Provider | None = None):
    """Where the collection's cards and value sit: by color, rarity, type, set and location."""
    provider = provider or preferred_provider(db, identity.owner_id)
    raw = Printing.source_json
    rows = db.execute(
        select(
            InventoryLot.printing_id,
            InventoryLot.finish,
            InventoryLot.quantity_remaining,
            InventoryLot.misprint,
            InventoryLot.altered,
            InventoryLot.purchase_price,
            InventoryLot.purchase_currency,
            CardPrice.amount,
            Binder.id,
            Binder.name,
            Printing.set_code,
            raw["set_name"].astext,
            raw["color_identity"],
            raw["rarity"].astext,
            raw["type_line"].astext,
        )
        .select_from(InventoryLot)
        .join(Printing, Printing.id == InventoryLot.printing_id)
        .join(Binder, Binder.id == InventoryLot.binder_id)
        .outerjoin(
            CardPrice,
            and_(
                CardPrice.printing_id == InventoryLot.printing_id,
                CardPrice.finish == InventoryLot.finish,
                CardPrice.provider == provider,
            ),
        )
        .where(InventoryLot.owner_id == identity.owner_id, InventoryLot.quantity_remaining > 0)
    ).all()
    colors, rarities, types, sets, locations = Tally(), Tally(), Tally(), Tally(), Tally()
    copies, total = 0, Decimal(0)
    best = {}
    paid_copies, paid, paid_now, paid_unpriced = 0, Decimal(0), Decimal(0), 0
    for (
        printing_id,
        finish,
        quantity,
        misprint,
        altered,
        purchase,
        currency,
        amount,
        binder_id,
        binder,
        set_code,
        set_name,
        identity_colors,
        rarity,
        type_line,
    ) in rows:
        unit = None if amount is None or misprint or altered else Decimal(amount)
        value = None if unit is None else unit * quantity
        copies += quantity
        total += value or 0
        color = color_group(identity_colors)
        colors.add(color, color, quantity, value)
        rarities.add(rarity or "", (rarity or "unknown").capitalize(), quantity, value)
        kind = type_group(type_line)
        types.add(kind, kind, quantity, value)
        sets.add(set_code, set_name or set_code.upper(), quantity, value)
        locations.add(str(binder_id), binder, quantity, value)
        if unit is not None:
            entry = best.setdefault((printing_id, finish), [unit, 0])
            entry[1] += quantity
        # Only dollar prices can be compared with today's dollar prices.
        if purchase is not None and (currency or "USD") == "USD" and not (misprint or altered):
            if unit is None:
                paid_unpriced += quantity
            else:
                paid_copies += quantity
                paid += Decimal(purchase) * quantity
                paid_now += value
    top = sorted(best.items(), key=lambda item: (-item[1][0], str(item[0][0])))[:10]
    printings = {
        card.id: card
        for card in db.scalars(select(Printing).where(Printing.id.in_([key[0] for key, _ in top])))
    }
    return {
        "provider": provider,
        "copies": copies,
        "value": money(total),
        "colors": colors.listed(COLOR_ORDER),
        "rarities": rarities.listed(RARITY_ORDER),
        "types": types.listed([*TYPE_ORDER, "Other"]),
        "sets": sets.listed(limit=12),
        "locations": locations.listed(limit=12),
        "top_cards": [
            {
                "printing": printing_json(printings[printing_id]),
                "finish": finish,
                "quantity": quantity,
                "amount": money(unit),
            }
            for (printing_id, finish), (unit, quantity) in top
        ],
        "paid": {
            "copies": paid_copies,
            "unpriced_copies": paid_unpriced,
            "paid": money(paid),
            "value": money(paid_now),
            "change": money(paid_now - paid),
        }
        if paid_copies
        else None,
    }


@router.get("/printings/{printing_id}/price-history")
def price_history(
    printing_id: uuid.UUID,
    identity: Identity,
    db: DB,
    provider: Provider | None = None,
    days: int = Query(90, ge=7, le=366),
):
    printing = db.get(Printing, printing_id)
    if printing is None:
        raise HTTPException(404, "This card isn’t in the catalog.")
    # History exists only for cards someone on this server owns or wants, so
    # showing it for any printing would reveal other accounts' collections.
    owned = db.scalar(
        select(InventoryLot.id)
        .where(
            InventoryLot.owner_id == identity.owner_id,
            InventoryLot.printing_id == printing_id,
            InventoryLot.quantity_remaining > 0,
        )
        .limit(1)
    ) or db.scalar(
        select(WishlistItem.id)
        .where(WishlistItem.owner_id == identity.owner_id, WishlistItem.printing_id == printing_id)
        .limit(1)
    )
    if not owned:
        raise HTTPException(404, "This card isn’t in your collection or wishlist.")
    provider = provider or preferred_provider(db, identity.owner_id)
    today = date.today()
    finishes = {
        finish: [] for finish in printing.finishes if finish in ("nonfoil", "foil", "etched")
    }
    for row in db.scalars(
        select(CardPriceHistory)
        .where(
            CardPriceHistory.printing_id == printing_id,
            CardPriceHistory.provider == provider,
            CardPriceHistory.day >= today - timedelta(days=days),
            CardPriceHistory.day < today,
        )
        .order_by(CardPriceHistory.day)
    ):
        finishes.setdefault(row.finish, []).append(
            {"day": row.day.isoformat(), "amount": money(Decimal(row.amount))}
        )
    for (_, finish), amount in finish_prices(db, provider, {printing_id}).items():
        finishes.setdefault(finish, []).append({"day": today.isoformat(), "amount": money(amount)})
    return {
        "provider": provider,
        "days": days,
        "finishes": {
            finish: {"points": points, "change": change(points)}
            for finish, points in finishes.items()
        },
    }


@router.get("/printings/{printing_id}/decks")
def card_decks(printing_id: uuid.UUID, identity: Identity, db: DB):
    """Which saved decks list this card (any printing) and how many owned copies are left."""
    printing = db.get(Printing, printing_id)
    if printing is None:
        raise HTTPException(404, "This card isn’t in the catalog.")
    owned = db.scalar(
        select(func.coalesce(func.sum(InventoryLot.quantity_remaining), 0))
        .join(Printing)
        .where(
            InventoryLot.owner_id == identity.owner_id,
            InventoryLot.quantity_remaining > 0,
            func.lower(Printing.name) == printing.name.lower(),
        )
    )
    decks = deck_usage(db, identity.owner_id, {printing.name})[printing.name.lower()]
    used = sum(deck["quantity"] for deck in decks)
    return {
        "name": printing.name,
        "owned": int(owned),
        "used": used,
        "free": max(0, int(owned) - used),
        "decks": decks,
    }


def number_order(value):
    match = re.match(r"(\d+)", value)
    return (int(match.group(1)) if match else 10**9, value)


@router.get("/sets")
def sets(identity: Identity, db: DB):
    owned = (
        select(
            Printing.set_code,
            func.count(func.distinct(Printing.collector_number)).label("owned"),
            func.sum(InventoryLot.quantity_remaining).label("copies"),
            func.max(Printing.source_json["set_name"].astext).label("name"),
            func.max(Printing.source_json["released_at"].astext).label("released_at"),
            func.max(Printing.source_json["set_type"].astext).label("set_type"),
        )
        .join(InventoryLot, InventoryLot.printing_id == Printing.id)
        .where(InventoryLot.owner_id == identity.owner_id, InventoryLot.quantity_remaining > 0)
        .group_by(Printing.set_code)
        .cte("owned_sets")
    )
    totals = (
        select(
            Printing.set_code,
            func.count(func.distinct(Printing.collector_number)).label("total"),
        )
        .where(Printing.set_code.in_(select(owned.c.set_code)))
        .group_by(Printing.set_code)
        .cte("set_totals")
    )
    rows = db.execute(
        select(owned, totals.c.total)
        .join(totals, totals.c.set_code == owned.c.set_code)
        .order_by(owned.c.released_at.desc().nulls_last(), owned.c.set_code)
    ).all()
    return {
        "items": [
            {
                "code": row.set_code,
                "name": row.name or row.set_code.upper(),
                "released_at": row.released_at,
                "set_type": row.set_type,
                "owned": row.owned,
                "total": row.total,
                "copies": int(row.copies),
            }
            for row in rows
        ]
    }


@router.get("/sets/{set_code}")
def set_detail(set_code: str, identity: Identity, db: DB, provider: Provider | None = None):
    set_code = set_code.lower()[:16]
    provider = provider or preferred_provider(db, identity.owner_id)
    printings = db.scalars(select(Printing).where(Printing.set_code == set_code)).all()
    if not printings:
        raise HTTPException(404, "This set isn’t in the catalog.")
    # One card per collector number; English when the catalog has it.
    chosen = {}
    for printing in sorted(printings, key=lambda p: (p.language != "en", str(p.id))):
        chosen.setdefault(printing.collector_number, printing)
    have = dict(
        db.execute(
            select(Printing.collector_number, func.sum(InventoryLot.quantity_remaining))
            .join(InventoryLot, InventoryLot.printing_id == Printing.id)
            .where(
                InventoryLot.owner_id == identity.owner_id,
                InventoryLot.quantity_remaining > 0,
                Printing.set_code == set_code,
            )
            .group_by(Printing.collector_number)
        ).all()
    )
    prices = finish_prices(db, provider, {printing.id for printing in chosen.values()})
    cards, cost, unpriced = [], Decimal(0), 0
    for number in sorted(chosen, key=number_order):
        printing = chosen[number]
        finish, amount = unit_price(prices, printing, "any")
        copies = int(have.get(number, 0))
        if not copies:
            if amount is None:
                unpriced += 1
            else:
                cost += amount
        cards.append(
            {
                "printing": printing_json(printing),
                "owned": copies,
                "price_finish": finish,
                "unit_amount": money(amount),
            }
        )
    sample = next(iter(chosen.values())).source_json
    return {
        "code": set_code,
        "name": sample.get("set_name") or set_code.upper(),
        "released_at": sample.get("released_at"),
        "provider": provider,
        "owned": sum(1 for card in cards if card["owned"]),
        "total": len(cards),
        "cost_to_finish": money(cost),
        "missing_unpriced": unpriced,
        "cards": cards,
    }
