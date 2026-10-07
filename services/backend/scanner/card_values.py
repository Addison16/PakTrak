"""Shared price and ownership lookups for wishlists, friends and trade offers."""

from collections import Counter
from decimal import Decimal

from sqlalchemy import func, select

from scanner.models import CardPrice, InventoryLot, Printing, User

FINISHES = ("nonfoil", "foil", "etched")


def preferred_provider(db, owner_id):
    return db.scalar(select(User.preferred_price_source).where(User.id == owner_id)) or "tcgplayer"


def finish_prices(db, provider, printing_ids):
    """Cached unit prices keyed by (printing_id, finish); absent quotes stay absent."""
    if not printing_ids:
        return {}
    prices = {}
    for quote in db.scalars(
        select(CardPrice).where(
            CardPrice.printing_id.in_(set(printing_ids)), CardPrice.provider == provider
        )
    ):
        amount = Decimal(quote.amount)
        if amount.is_finite() and amount > 0:
            prices[(quote.printing_id, quote.finish)] = amount
    return prices


def unit_price(prices, printing, finish):
    """A wanted "any" finish uses the cheapest priced finish the printing comes in."""
    if finish in FINISHES:
        return finish, prices.get((printing.id, finish))
    quoted = [
        (prices[(printing.id, value)], value)
        for value in FINISHES
        if value in printing.finishes and (printing.id, value) in prices
    ]
    if not quoted:
        return None, None
    amount, value = min(quoted)
    return value, amount


def owned_by_name(db, owner_id, names):
    """Copies an account owns of each card name, across every printing."""
    names = {name.lower() for name in names}
    if not names:
        return Counter()
    rows = db.execute(
        select(func.lower(Printing.name), func.sum(InventoryLot.quantity_remaining))
        .join(InventoryLot, InventoryLot.printing_id == Printing.id)
        .where(
            InventoryLot.owner_id == owner_id,
            InventoryLot.quantity_remaining > 0,
            func.lower(Printing.name).in_(names),
        )
        .group_by(func.lower(Printing.name))
    ).all()
    return Counter({name: int(quantity) for name, quantity in rows})


def owned_copies(db, owner_id, keys):
    """Copies owned of exact (printing, finish) pairs. Unknown-finish copies count for any finish."""
    printing_ids = {printing_id for printing_id, _ in keys}
    if not printing_ids:
        return Counter()
    rows = db.execute(
        select(
            InventoryLot.printing_id,
            InventoryLot.finish,
            func.sum(InventoryLot.quantity_remaining),
        )
        .where(
            InventoryLot.owner_id == owner_id,
            InventoryLot.quantity_remaining > 0,
            InventoryLot.printing_id.in_(printing_ids),
        )
        .group_by(InventoryLot.printing_id, InventoryLot.finish)
    ).all()
    found = Counter()
    for printing_id, finish, quantity in rows:
        for wanted in FINISHES:
            if (printing_id, wanted) in keys and finish in (wanted, "unknown"):
                found[(printing_id, wanted)] += int(quantity)
    return found


def money(amount):
    return str(amount.quantize(Decimal("0.01"))) if amount is not None else None
