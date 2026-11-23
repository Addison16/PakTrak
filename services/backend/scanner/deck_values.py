"""Reference values for exact deck printings, using only the local price cache."""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from sqlalchemy import and_, select

from scanner.data_sync import PROVIDERS
from scanner.gallery import feed_json
from scanner.models import CardPrice, CardPriceHistory, DataFeed, PriceWatch, now

FinishPreference = Literal["nonfoil", "foil", "etched"]
FINISHES = ("nonfoil", "foil", "etched")
# How far back a deck card's price is compared, to point out cards that jumped.
COMPARE_DAYS = 30


def earlier_prices(db, printing_ids, provider, owner_id):
    """The oldest saved price in the comparison window for each printing and finish.

    Only prices saved since this account has had the card: older ones exist
    because another account has it, and would give that away.
    """
    today = date.today()
    earlier = {}
    if owner_id is None:
        return earlier
    for row in db.scalars(
        select(CardPriceHistory)
        .join(
            PriceWatch,
            and_(
                PriceWatch.owner_id == owner_id,
                PriceWatch.printing_id == CardPriceHistory.printing_id,
                PriceWatch.day < CardPriceHistory.day,
            ),
        )
        .where(
            CardPriceHistory.printing_id.in_(printing_ids),
            CardPriceHistory.provider == provider,
            CardPriceHistory.day >= today - timedelta(days=COMPARE_DAYS),
            CardPriceHistory.day < today,
        )
        .order_by(CardPriceHistory.day.desc())
    ):
        earlier[(row.printing_id, row.finish)] = (Decimal(row.amount), row.day)
    return earlier


def was(found):
    amount, day = found or (None, None)
    return {
        "earlier_amount": str(amount) if amount is not None else None,
        "earlier_day": day.isoformat() if day else None,
    }


def value_report(db, rows, provider="tcgplayer", finish_preference="nonfoil", owner_id=None):
    quotes = defaultdict(dict)
    for quote in db.scalars(
        select(CardPrice).where(
            CardPrice.printing_id.in_({printing.id for _, printing in rows}),
            CardPrice.provider == provider,
        )
    ):
        amount = Decimal(quote.amount)
        if amount.is_finite() and amount > 0:
            quotes[quote.printing_id][quote.finish] = amount

    def subtotal(items):
        copies = sum(item["quantity"] for item in items)
        priced = sum(item["quantity"] for item in items if item["unit_amount"] is not None)
        total = sum(
            (Decimal(item["amount"]) for item in items if item["amount"] is not None),
            Decimal(0),
        )
        return {
            "copies": copies,
            "priced_copies": priced,
            "unpriced_copies": copies - priced,
            "amount": str(total) if priced or not copies else None,
        }

    earlier = earlier_prices(db, {printing.id for _, printing in rows}, provider, owner_id)
    items = []
    for choice, printing in rows:
        available = [finish for finish in FINISHES if finish in printing.finishes]
        finish = (
            finish_preference if finish_preference in available else next(iter(available), None)
        )
        # Fallback only for unsupported finishes, never for a missing price.
        amount = quotes[printing.id].get(finish)
        items.append(
            {
                "printing_id": str(printing.id),
                "name": printing.name,
                "set_code": printing.set_code,
                "collector_number": printing.collector_number,
                "section": choice.section,
                "quantity": choice.quantity,
                "finish": finish,
                "finish_fallback": finish is not None and finish != finish_preference,
                "unit_amount": str(amount) if amount is not None else None,
                "amount": str(amount * choice.quantity) if amount is not None else None,
                **was(earlier.get((printing.id, finish)) if amount is not None else None),
                "unpriced_reason": None
                if amount is not None
                else "missing_price"
                if finish
                else "unknown_finish",
            }
        )
    items.sort(key=lambda item: (item["section"], item["name"].casefold(), item["printing_id"]))
    feed = db.get(DataFeed, PROVIDERS[provider]["feed"])
    return {
        **subtotal(items),
        "provider": provider,
        "currency": "USD",
        "price_kind": PROVIDERS[provider]["kind"],
        "finish_preference": finish_preference,
        "fallback_copies": sum(item["quantity"] for item in items if item["finish_fallback"]),
        "sections": {
            section: subtotal([item for item in items if item["section"] == section])
            for section in ("commander", "main", "sideboard")
        },
        "items": items,
        "feed": feed_json(feed) if feed else None,
        "checked_at": now(),
    }
