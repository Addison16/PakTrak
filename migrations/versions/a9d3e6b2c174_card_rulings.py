"""Official card rulings saved from the daily catalog update."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "a9d3e6b2c174"
down_revision = "e7a3c5f19b82"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "card_rulings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("oracle_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("published_at", sa.Date(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
    )


def downgrade():
    op.drop_table("card_rulings")
