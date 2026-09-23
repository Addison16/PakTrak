"""Remember each account's preferred card pricing source."""

import sqlalchemy as sa
from alembic import op

revision = "38e92a17d6b4"
down_revision = "a6134ec86240"
branch_labels = None
depends_on = None


def upgrade():
    # Keep existing accounts unset so their device preference can be migrated.
    op.add_column("users", sa.Column("preferred_price_source", sa.String(32), nullable=True))
    op.create_check_constraint(
        "user_valid_price_source",
        "users",
        "preferred_price_source IN ('tcgplayer','cardkingdom','manapool')",
    )


def downgrade():
    op.drop_constraint("user_valid_price_source", "users", type_="check")
    op.drop_column("users", "preferred_price_source")
