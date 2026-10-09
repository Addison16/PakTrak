"""Home screen notices for owned cards whose price moved since the owner last looked.

The price cache only holds today's quotes, so each owner keeps a baseline per owned
finish. A new card's first quote becomes its baseline silently. A card alerts once its
change meets every threshold the owner set, and its baseline moves only when the owner
dismisses that alert, so slow drift still adds up to an alert later.
"""

import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, delete, exists, func, select, tuple_
from sqlalchemy.dialects.postgresql import insert

from scanner.auth import DB, Identity
from scanner.data_sync import PROVIDERS
from scanner.gallery import feed_json, image_url
from scanner.models import (
    CardPrice,
    CardPriceHistory,
    CollectionValueHistory,
    DataFeed,
    InventoryLot,
    PriceAlertBaseline,
    Printing,
    User,
    now,
)

router = APIRouter(prefix="/api/v1/price-alerts", tags=["price alerts"])
PRICED_FINISHES = ("nonfoil", "foil", "etched")
LIMIT = 100


def settings_json(user):
    return {
        "enabled": user.price_alerts_enabled,
        "percent": user.price_alert_percent,
        "amount": None if user.price_alert_amount is None else f"{user.price_alert_amount:.2f}",
    }


def owned_quotes(db, owner_id, provider):
    """Owned, normally priced finishes with today's quote from the owner's source."""
    owned = (
        select(
            InventoryLot.printing_id,
            InventoryLot.finish,
            func.sum(InventoryLot.quantity_remaining).label("quantity"),
        )
        .where(
            InventoryLot.owner_id == owner_id,
            InventoryLot.quantity_remaining > 0,
            InventoryLot.finish.in_(PRICED_FINISHES),
            # Misprints and altered cards carry their own value, not the market quote.
            InventoryLot.misprint.is_not(True),
            InventoryLot.altered.is_not(True),
        )
        .group_by(InventoryLot.printing_id, InventoryLot.finish)
        .subquery()
    )
    return db.execute(
        select(owned.c.printing_id, owned.c.finish, owned.c.quantity, CardPrice.amount, Printing)
        .join(
            CardPrice,
            and_(
                CardPrice.printing_id == owned.c.printing_id,
                CardPrice.finish == owned.c.finish,
                CardPrice.provider == provider,
            ),
        )
        .join(Printing, Printing.id == owned.c.printing_id)
    ).all()


def moved(old, new, user):
    change = new - old
    if not change:
        return False
    if user.price_alert_amount is not None and abs(change) < Decimal(user.price_alert_amount):
        return False
    if user.price_alert_percent is not None and abs(change) * 100 < old * user.price_alert_percent:
        return False
    return user.price_alert_amount is not None or user.price_alert_percent is not None


def collection_change(db, owner_id, provider, quotes):
    """How today's prices moved the owner's whole collection since the update before.

    Only price moves count: a copy added or removed since then doesn't change the
    figure, and a card with no earlier price is left out of both sides.
    """
    # The owner's own daily totals are a small table, so the days come from there.
    days = db.scalars(
        select(CollectionValueHistory.day)
        .where(
            CollectionValueHistory.owner_id == owner_id,
            CollectionValueHistory.provider == provider,
        )
        .order_by(CollectionValueHistory.day.desc())
        .limit(2)
    ).all()
    if len(days) < 2:
        return None
    before = days[1]
    owned = (
        select(InventoryLot.printing_id, InventoryLot.finish)
        .where(InventoryLot.owner_id == owner_id, InventoryLot.quantity_remaining > 0)
        .distinct()
        .subquery()
    )
    earlier = {
        (row.printing_id, row.finish): Decimal(row.amount)
        for row in db.execute(
            select(CardPriceHistory.printing_id, CardPriceHistory.finish, CardPriceHistory.amount)
            .join(
                owned,
                and_(
                    owned.c.printing_id == CardPriceHistory.printing_id,
                    owned.c.finish == CardPriceHistory.finish,
                ),
            )
            .where(CardPriceHistory.provider == provider, CardPriceHistory.day == before)
        )
    }
    then = change = Decimal(0)
    for printing_id, finish, quantity, amount, _ in quotes:
        old = earlier.get((printing_id, finish))
        if old is not None:
            then += old * quantity
            change += (Decimal(amount) - old) * quantity
    if not then:
        return None
    return {
        "change": f"{change:.2f}",
        "percent": round(float(change / then * 100), 1),
        "since": before.isoformat(),
    }


@router.get("")
def price_alerts(identity: Identity, db: DB):
    user = db.get(User, identity.owner_id)
    provider = user.preferred_price_source or "tcgplayer"
    feed = db.get(DataFeed, PROVIDERS[provider]["feed"])
    result = {
        "settings": settings_json(user),
        "provider": provider,
        "currency": "USD",
        "feed": feed_json(feed) if feed else None,
        "rises": [],
        "drops": [],
        "rise_count": 0,
        "drop_count": 0,
        # Every alerting copy counted, not just the listed ones.
        "rise_total": "0.00",
        "drop_total": "0.00",
        "collection": None,
    }
    if not user.price_alerts_enabled:
        db.commit()
        return result
    # A baseline lives only while a normally priced copy that was owned when watching
    # began is still owned. Otherwise a card removed and later re-added would be compared
    # with its old price instead of starting fresh.
    db.execute(
        delete(PriceAlertBaseline).where(
            PriceAlertBaseline.owner_id == user.id,
            ~exists().where(
                InventoryLot.owner_id == user.id,
                InventoryLot.printing_id == PriceAlertBaseline.printing_id,
                InventoryLot.finish == PriceAlertBaseline.finish,
                InventoryLot.quantity_remaining > 0,
                InventoryLot.misprint.is_not(True),
                InventoryLot.altered.is_not(True),
                InventoryLot.created_at <= PriceAlertBaseline.started_at,
            ),
        )
    )
    quotes = owned_quotes(db, user.id, provider)
    baselines = {
        (row.printing_id, row.finish): row
        for row in db.scalars(
            select(PriceAlertBaseline).where(PriceAlertBaseline.owner_id == user.id)
        )
    }
    fresh, rises, drops = [], [], []
    for printing_id, finish, quantity, amount, printing in quotes:
        amount = Decimal(amount)
        baseline = baselines.get((printing_id, finish))
        if baseline is None or baseline.provider != provider:
            # A switched source would otherwise compare one store's price with another's.
            fresh.append((printing_id, finish, amount))
            continue
        old = Decimal(baseline.amount)
        if not moved(old, amount, user):
            continue
        change = amount - old
        item = {
            "printing_id": str(printing_id),
            "name": printing.name,
            "set_code": printing.set_code,
            "collector_number": printing.collector_number,
            "finish": finish,
            "quantity": quantity,
            "image_url": image_url(printing),
            "old_amount": f"{old:.2f}",
            "new_amount": f"{amount:.2f}",
            "change": f"{change:.2f}",
            "percent": round(float(change / old * 100), 1),
            "since": baseline.seen_at,
        }
        (rises if change > 0 else drops).append((abs(change) * quantity, item))
    if fresh:
        statement = insert(PriceAlertBaseline).values(
            [
                {
                    "owner_id": user.id,
                    "printing_id": printing_id,
                    "finish": finish,
                    "provider": provider,
                    "amount": amount,
                    "seen_at": now(),
                    "started_at": now(),
                }
                for printing_id, finish, amount in fresh
            ]
        )
        db.execute(
            statement.on_conflict_do_update(
                index_elements=["owner_id", "printing_id", "finish"],
                set_={
                    "provider": statement.excluded.provider,
                    "amount": statement.excluded.amount,
                    "seen_at": statement.excluded.seen_at,
                    "started_at": statement.excluded.started_at,
                },
            )
        )
    db.commit()
    # Biggest moves for the whole holding first, so a playset outranks a single copy.
    for key, items in (("rises", rises), ("drops", drops)):
        items.sort(key=lambda entry: (-entry[0], entry[1]["name"].casefold()))
        result[key] = [item for _, item in items[:LIMIT]]
        result[key[:-1] + "_count"] = len(items)
        result[key[:-1] + "_total"] = f"{sum((held for held, _ in items), Decimal(0)):.2f}"
    if rises or drops:
        result["collection"] = collection_change(db, user.id, provider, quotes)
    return result


class AlertSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)
    percent: int | None = Field(default=None, ge=1, le=1000, strict=True)
    amount: Decimal | None = Field(default=None, gt=0, le=100000, decimal_places=2)

    @model_validator(mode="after")
    def needs_threshold(self):
        if self.enabled and self.percent is None and self.amount is None:
            raise ValueError("Set a percent, a dollar amount or both to turn on price alerts.")
        return self


@router.put("/settings")
def update_settings(data: AlertSettings, identity: Identity, db: DB):
    user = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    user.price_alerts_enabled = data.enabled
    user.price_alert_percent = data.percent
    user.price_alert_amount = data.amount
    db.commit()
    return settings_json(user)


class SeenCard(BaseModel):
    model_config = ConfigDict(extra="forbid")
    printing_id: uuid.UUID
    finish: Literal["nonfoil", "foil", "etched"]


class SeenAlerts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cards: list[SeenCard] = Field(min_length=1, max_length=2 * LIMIT)


@router.post("/seen")
def mark_seen(data: SeenAlerts, identity: Identity, db: DB):
    """Only the cards the notice showed take today's price as their new baseline."""
    user = db.get(User, identity.owner_id)
    provider = user.preferred_price_source or "tcgplayer"
    keys = {(card.printing_id, card.finish) for card in data.cards}
    current = select(CardPrice.amount).where(
        CardPrice.printing_id == PriceAlertBaseline.printing_id,
        CardPrice.finish == PriceAlertBaseline.finish,
        CardPrice.provider == provider,
    )
    updated = db.execute(
        PriceAlertBaseline.__table__.update()
        .where(
            PriceAlertBaseline.owner_id == user.id,
            tuple_(PriceAlertBaseline.printing_id, PriceAlertBaseline.finish).in_(keys),
            exists(current),
        )
        .values(amount=current.scalar_subquery(), provider=provider, seen_at=now())
    ).rowcount
    db.commit()
    return {"updated": updated}
