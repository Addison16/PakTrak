"""Durable recognition results and batch deletion barrier.

Revision ID: 910b42ac6f18
Revises: 67b08c53f924
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "910b42ac6f18"
down_revision = "67b08c53f924"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("scans", sa.Column("deleted_at", sa.DateTime(timezone=True)))
    op.create_index("ix_scans_deleted_at", "scans", ["deleted_at"])
    op.add_column(
        "observations",
        sa.Column("recognition", postgresql.JSONB(), nullable=False, server_default="{}"),
    )


def downgrade():
    op.drop_column("observations", "recognition")
    op.drop_index("ix_scans_deleted_at", table_name="scans")
    op.drop_column("scans", "deleted_at")
