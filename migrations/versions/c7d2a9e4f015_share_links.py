"""Read-only share links for a deck or the wishlist."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "c7d2a9e4f015"
down_revision = "b4e8f1c6d203"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "share_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "owner_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("deck_id", UUID(as_uuid=True), sa.ForeignKey("decks.id", ondelete="CASCADE")),
        sa.Column("token", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('deck','wishlist')", name="share_link_kind_valid"),
        sa.CheckConstraint("(kind = 'deck') = (deck_id IS NOT NULL)", name="share_link_deck_only"),
    )


def downgrade():
    op.drop_table("share_links")
