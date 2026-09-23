"""Persist pre-upload foil counts and per-region finish selections.

Revision ID: b607cd341a92
Revises: 910b42ac6f18
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b607cd341a92"
down_revision = "910b42ac6f18"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("scans", sa.Column("foil_count", sa.Integer()))
    op.add_column("scans", sa.Column("finish_selection", postgresql.JSONB()))
    op.create_check_constraint("scan_foil_count_valid", "scans", "foil_count BETWEEN 0 AND 32")
    op.add_column(
        "observations", sa.Column("finish", sa.String(32), nullable=False, server_default="unknown")
    )
    op.create_check_constraint(
        "observation_finish_valid",
        "observations",
        "finish IN ('unknown','nonfoil','foil','etched')",
    )
    op.execute(
        "UPDATE observations o SET finish = l.finish FROM inventory_lots l WHERE l.source_observation_id = o.id"
    )


def downgrade():
    op.drop_constraint("observation_finish_valid", "observations", type_="check")
    op.drop_column("observations", "finish")
    op.drop_constraint("scan_foil_count_valid", "scans", type_="check")
    op.drop_column("scans", "finish_selection")
    op.drop_column("scans", "foil_count")
