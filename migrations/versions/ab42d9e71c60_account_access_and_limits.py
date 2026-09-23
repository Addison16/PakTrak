"""Personal profiles, account access and configurable lifetime card allowances."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "ab42d9e71c60"
down_revision = "f19b63c7e820"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("profile_name", sa.String(80), nullable=True))
    op.add_column(
        "users", sa.Column("suspended", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.add_column(
        "users", sa.Column("scans_paused", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.add_column("users", sa.Column("scan_card_limit_override", sa.Integer(), nullable=True))
    op.add_column(
        "users", sa.Column("account_version", sa.Integer(), nullable=False, server_default="1")
    )
    op.create_check_constraint(
        "user_scan_limit_nonnegative", "users", "scan_card_limit_override >= 0"
    )
    op.create_check_constraint("user_account_version_positive", "users", "account_version >= 1")
    op.create_table(
        "account_events",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "owner_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("actor_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("detail", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_account_events_owner_id", "account_events", ["owner_id"])


def downgrade():
    op.drop_table("account_events")
    op.drop_constraint("user_scan_limit_nonnegative", "users", type_="check")
    op.drop_constraint("user_account_version_positive", "users", type_="check")
    for column in [
        "account_version",
        "scan_card_limit_override",
        "scans_paused",
        "suspended",
        "profile_name",
    ]:
        op.drop_column("users", column)
