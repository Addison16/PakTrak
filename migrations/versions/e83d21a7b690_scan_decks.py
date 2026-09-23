"""Photo scans for saved decks without manufacturing collection copies."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e83d21a7b690"
down_revision = "c72d10a4e691"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "scans",
        sa.Column("add_to_collection", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "scans", sa.Column("target_deck_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.create_foreign_key(
        "scans_target_deck_id_fkey",
        "scans",
        "decks",
        ["target_deck_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_scans_target_deck_id", "scans", ["target_deck_id"])
    op.add_column(
        "observations",
        sa.Column("confirmed_printing_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "observations_confirmed_printing_id_fkey",
        "observations",
        "card_printings",
        ["confirmed_printing_id"],
        ["id"],
    )
    op.create_table(
        "deck_scan_cards",
        sa.Column(
            "deck_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("decks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "observation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("observations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("deck_scan_request", "deck_scan_cards", ["deck_id", "request_key"])


def downgrade():
    op.drop_table("deck_scan_cards")
    op.drop_constraint(
        "observations_confirmed_printing_id_fkey", "observations", type_="foreignkey"
    )
    op.drop_column("observations", "confirmed_printing_id")
    op.drop_index("ix_scans_target_deck_id", table_name="scans")
    op.drop_constraint("scans_target_deck_id_fkey", "scans", type_="foreignkey")
    op.drop_column("scans", "target_deck_id")
    op.drop_column("scans", "add_to_collection")
