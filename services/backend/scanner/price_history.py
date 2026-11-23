"""Daily price and collection value history, saved with each price update."""

from sqlalchemy import text

KEEP_DAYS = 400
# Every card an account has: owned, wanted or in one of its decks.
HELD = """
    SELECT owner_id, printing_id FROM inventory_lots WHERE quantity_remaining > 0
    UNION ALL SELECT owner_id, printing_id FROM wishlist_items
    UNION ALL SELECT deck.owner_id, card.printing_id
        FROM deck_cards AS card JOIN decks AS deck ON deck.id = card.deck_id
"""


def record_history(db, provider):
    """Save today's prices for owned, wanted or deck printings and each account's total.

    Called inside the price replacement transaction, so history and the price
    cache always change together. Repeated updates on one day keep the latest.
    """
    params = {"provider": provider, "keep": KEEP_DAYS}
    db.execute(
        text(
            """
            INSERT INTO card_price_history (printing_id, provider, finish, day, amount)
            SELECT price.printing_id, price.provider, price.finish, CURRENT_DATE, price.amount
            FROM card_prices AS price
            WHERE price.provider = :provider AND price.printing_id IN (
                SELECT printing_id FROM inventory_lots WHERE quantity_remaining > 0
                UNION SELECT printing_id FROM wishlist_items
                UNION SELECT printing_id FROM deck_cards
            )
            ON CONFLICT (printing_id, provider, finish, day)
            DO UPDATE SET amount = excluded.amount
            """
        ),
        params,
    )
    db.execute(
        text(
            """
            INSERT INTO collection_value_history
                (owner_id, provider, day, amount, priced_copies, copies)
            SELECT lot.owner_id, :provider, CURRENT_DATE,
                COALESCE(SUM(lot.quantity_remaining * price.amount) FILTER (WHERE priced), 0),
                COALESCE(SUM(lot.quantity_remaining) FILTER (WHERE priced), 0),
                SUM(lot.quantity_remaining)
            FROM inventory_lots AS lot
            LEFT JOIN card_prices AS price ON price.printing_id = lot.printing_id
                AND price.finish = lot.finish AND price.provider = :provider
            CROSS JOIN LATERAL (
                SELECT price.amount IS NOT NULL AND lot.misprint IS NOT TRUE
                    AND lot.altered IS NOT TRUE AS priced
            ) AS checked
            WHERE lot.quantity_remaining > 0
            GROUP BY lot.owner_id
            ON CONFLICT (owner_id, provider, day) DO UPDATE SET amount = excluded.amount,
                priced_copies = excluded.priced_copies, copies = excluded.copies
            """
        ),
        params,
    )
    # Each account's saved prices for a card start with the first update that ran
    # while it had the card, and start over if it lets the card go.
    db.execute(
        text(
            f"""
            INSERT INTO price_watches (owner_id, printing_id, day)
            SELECT DISTINCT held.owner_id, held.printing_id, CURRENT_DATE FROM ({HELD}) AS held
            ON CONFLICT (owner_id, printing_id) DO NOTHING
            """
        )
    )
    db.execute(
        text(
            f"""
            DELETE FROM price_watches AS watch WHERE NOT EXISTS (
                SELECT 1 FROM ({HELD}) AS held
                WHERE held.owner_id = watch.owner_id AND held.printing_id = watch.printing_id
            )
            """
        )
    )
    for table in ("card_price_history", "collection_value_history"):
        db.execute(
            text(f"DELETE FROM {table} WHERE provider = :provider AND day < CURRENT_DATE - :keep"),
            params,
        )
