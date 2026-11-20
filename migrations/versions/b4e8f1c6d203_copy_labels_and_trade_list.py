"""Labels on owned copies and a for-trade mark."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "b4e8f1c6d203"
down_revision = "a9d3e6b2c174"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "inventory_lots",
        sa.Column("labels", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    op.add_column(
        "inventory_lots",
        sa.Column("for_trade", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_column("inventory_lots", "for_trade")
    op.drop_column("inventory_lots", "labels")
