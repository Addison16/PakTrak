"""Remember when each price alert baseline started, so re-added cards start fresh."""

import sqlalchemy as sa
from alembic import op

revision = "c4f2e8a1d905"
down_revision = "c8e4f2a6b913"
branch_labels = None
depends_on = None


def upgrade():
    # Existing baselines started when they were last seen, the closest known time.
    op.add_column(
        "price_alert_baselines",
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE price_alert_baselines SET started_at = seen_at")
    op.alter_column("price_alert_baselines", "started_at", nullable=False)


def downgrade():
    op.drop_column("price_alert_baselines", "started_at")
