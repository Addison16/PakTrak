"""The most an account wants to pay for a wanted card."""

import sqlalchemy as sa
from alembic import op

revision = "d3f6b8a1e942"
down_revision = "c7d2a9e4f015"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("wishlist_items", sa.Column("target_price", sa.Numeric(9, 2)))
    op.create_check_constraint(
        "wishlist_target_price_valid",
        "wishlist_items",
        "target_price IS NULL OR target_price > 0",
    )


def downgrade():
    op.drop_constraint("wishlist_target_price_valid", "wishlist_items", type_="check")
    op.drop_column("wishlist_items", "target_price")
