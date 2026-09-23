"""Fence active sign-ins while an administrator resets credentials."""

import sqlalchemy as sa
from alembic import op

revision = "c72d10a4e691"
down_revision = "ab42d9e71c60"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users", sa.Column("password_reset_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users",
        sa.Column(
            "password_reset_pending", sa.Boolean(), server_default=sa.false(), nullable=False
        ),
    )


def downgrade():
    op.drop_column("users", "password_reset_pending")
    op.drop_column("users", "password_reset_at")
