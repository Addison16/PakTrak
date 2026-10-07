"""Wishlists, friend codes, trade offers and daily price history."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "c8e4f2a6b913"
down_revision = "5b1e7c9d2a40"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("friend_code", sa.String(16), nullable=True))
    op.create_unique_constraint("users_friend_code_key", "users", ["friend_code"])
    op.add_column(
        "users",
        sa.Column("share_collection", sa.Boolean(), server_default="true", nullable=False),
    )
    op.add_column(
        "users", sa.Column("share_wishlist", sa.Boolean(), server_default="true", nullable=False)
    )
    op.create_table(
        "wishlist_items",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "printing_id",
            sa.Uuid(),
            sa.ForeignKey("card_printings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("finish", sa.String(16), server_default="any", nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("notes", sa.String(500), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("owner_id", "printing_id", "finish"),
        sa.CheckConstraint("quantity > 0 AND quantity <= 999", name="wishlist_quantity_valid"),
        sa.CheckConstraint(
            "finish IN ('any','nonfoil','foil','etched')", name="wishlist_finish_valid"
        ),
    )
    op.create_index("ix_wishlist_items_owner_id", "wishlist_items", ["owner_id"])
    op.create_table(
        "card_price_history",
        sa.Column(
            "printing_id",
            sa.Uuid(),
            sa.ForeignKey("card_printings.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider", sa.String(32), primary_key=True),
        sa.Column("finish", sa.String(16), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("amount", sa.Numeric(16, 4), nullable=False),
        sa.CheckConstraint("amount > 0", name="price_history_positive"),
    )
    op.create_table(
        "collection_value_history",
        sa.Column(
            "owner_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider", sa.String(32), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("amount", sa.Numeric(16, 4), nullable=False),
        sa.Column("priced_copies", sa.Integer(), nullable=False),
        sa.Column("copies", sa.Integer(), nullable=False),
    )
    op.create_table(
        "friendships",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_a", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "user_b", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("requested_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_a", "user_b"),
        sa.CheckConstraint("user_a < user_b", name="friendship_ordered_pair"),
        sa.CheckConstraint("requested_by IN (user_a, user_b)", name="friendship_requester_member"),
        sa.CheckConstraint("state IN ('pending','accepted')", name="friendship_state_valid"),
    )
    op.create_index("ix_friendships_user_b", "friendships", ["user_b"])
    op.create_table(
        "trade_offers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "sender_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "recipient_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("message", sa.String(500), server_default="", nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sender_applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recipient_applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sender_closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recipient_closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("sender_id", "request_key"),
        sa.CheckConstraint("sender_id <> recipient_id", name="trade_offer_not_self"),
        sa.CheckConstraint(
            "state IN ('pending','accepted','declined','cancelled')",
            name="trade_offer_state_valid",
        ),
    )
    op.create_index("ix_trade_offers_sender_id", "trade_offers", ["sender_id"])
    op.create_index("ix_trade_offers_recipient_id", "trade_offers", ["recipient_id"])
    op.create_table(
        "trade_offer_cards",
        sa.Column(
            "offer_id",
            sa.Uuid(),
            sa.ForeignKey("trade_offers.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("side", sa.String(16), primary_key=True),
        sa.Column(
            "printing_id",
            sa.Uuid(),
            sa.ForeignKey("card_printings.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("finish", sa.String(16), primary_key=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.CheckConstraint("side IN ('sender','recipient')", name="trade_card_side_valid"),
        sa.CheckConstraint("quantity > 0 AND quantity <= 999", name="trade_card_quantity_valid"),
        sa.CheckConstraint("finish IN ('nonfoil','foil','etched')", name="trade_card_finish_valid"),
    )


def downgrade():
    op.drop_table("trade_offer_cards")
    op.drop_table("trade_offers")
    op.drop_table("friendships")
    op.drop_table("collection_value_history")
    op.drop_table("card_price_history")
    op.drop_table("wishlist_items")
    op.drop_column("users", "share_wishlist")
    op.drop_column("users", "share_collection")
    op.drop_constraint("users_friend_code_key", "users")
    op.drop_column("users", "friend_code")
