"""Optional server-side scan enhancement, disabled for existing installations."""

import sqlalchemy as sa
from alembic import op

revision = "f19b63c7e820"
down_revision = "c80f67e910a2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "account_policy",
        sa.Column(
            "enhanced_scanning_enabled", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )
    op.alter_column("account_policy", "enhanced_scanning_enabled", server_default=None)


def downgrade():
    op.drop_column("account_policy", "enhanced_scanning_enabled")
