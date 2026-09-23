"""Offer the onboarding tour once to new accounts."""

import sqlalchemy as sa
from alembic import op

revision = "67b08c53f924"
down_revision = "38e92a17d6b4"
branch_labels = None
depends_on = None


def upgrade():
    # Existing collectors already know their library. The temporary true
    # default backfills their rows without interrupting them with the tour.
    op.add_column(
        "users", sa.Column("tour_dismissed", sa.Boolean(), nullable=False, server_default=sa.true())
    )
    op.alter_column(
        "users", "tour_dismissed", existing_type=sa.Boolean(), server_default=sa.false()
    )


def downgrade():
    op.drop_column("users", "tour_dismissed")
