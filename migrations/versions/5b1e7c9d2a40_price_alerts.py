"""Per-account price alert thresholds and the prices each owner last saw."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "5b1e7c9d2a40"
down_revision = "b3d5a8e1c947"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("price_alerts_enabled", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "users", sa.Column("price_alert_percent", sa.Integer(), nullable=True, server_default="20")
    )
    op.add_column(
        "users",
        sa.Column("price_alert_amount", sa.Numeric(10, 2), nullable=True, server_default="1.00"),
    )
    op.create_check_constraint(
        "user_price_alert_percent_range", "users", "price_alert_percent BETWEEN 1 AND 1000"
    )
    op.create_check_constraint(
        "user_price_alert_amount_positive", "users", "price_alert_amount > 0"
    )
    op.create_table(
        "price_alert_baselines",
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("printing_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("finish", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("amount", sa.Numeric(16, 4), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("amount > 0", name="price_alert_baseline_positive"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["printing_id"], ["card_printings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("owner_id", "printing_id", "finish"),
    )


def downgrade():
    op.drop_table("price_alert_baselines")
    op.drop_constraint("user_price_alert_amount_positive", "users", type_="check")
    op.drop_constraint("user_price_alert_percent_range", "users", type_="check")
    op.drop_column("users", "price_alert_amount")
    op.drop_column("users", "price_alert_percent")
    op.drop_column("users", "price_alerts_enabled")
