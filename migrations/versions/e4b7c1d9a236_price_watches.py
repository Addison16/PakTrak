"""The day each account's saved prices for a card begin."""

import sqlalchemy as sa
from alembic import op

revision = "e4b7c1d9a236"
down_revision = "d3f6b8a1e942"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "price_watches",
        sa.Column(
            "owner_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "printing_id",
            sa.Uuid(),
            sa.ForeignKey("card_printings.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("day", sa.Date(), nullable=False),
    )
    # Cards already here start from when the account got them. A deck records no
    # date per card, so its cards start from the deck's last change.
    op.execute(
        """
        INSERT INTO price_watches (owner_id, printing_id, day)
        SELECT owner_id, printing_id, MIN(day) FROM (
            SELECT owner_id, printing_id, created_at::date AS day
                FROM inventory_lots WHERE quantity_remaining > 0
            UNION ALL SELECT owner_id, printing_id, created_at::date FROM wishlist_items
            UNION ALL SELECT deck.owner_id, card.printing_id, deck.updated_at::date
                FROM deck_cards AS card JOIN decks AS deck ON deck.id = card.deck_id
        ) AS held
        GROUP BY owner_id, printing_id
        """
    )


def downgrade():
    op.drop_table("price_watches")
