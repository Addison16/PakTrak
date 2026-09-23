"""Cached card prices, daily data updates and durable import progress."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "a6134ec86240"
down_revision = "271f4b35a720"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "data_feeds",
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("progress", postgresql.JSONB(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
        sa.Column("next_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_time", sa.String(100)),
        sa.Column("error", sa.String(255)),
        sa.Column("records", sa.Integer(), nullable=False),
        sa.Column("failures", sa.Integer(), nullable=False),
    )
    op.create_table(
        "card_prices",
        sa.Column(
            "printing_id",
            sa.Uuid(),
            sa.ForeignKey("card_printings.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider", sa.String(32), primary_key=True),
        sa.Column("finish", sa.String(16), primary_key=True),
        sa.Column("amount", sa.Numeric(16, 4), nullable=False),
        sa.Column("url", sa.String(1024)),
        sa.Column("available", sa.Boolean()),
        sa.CheckConstraint("amount > 0", name="card_price_positive"),
        sa.CheckConstraint("finish IN ('nonfoil','foil','etched')", name="card_price_finish"),
    )
    op.create_table(
        "work_progress",
        sa.Column(
            "job_id", sa.Uuid(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("token", sa.Uuid()),
        sa.Column("data", postgresql.JSONB(), nullable=False),
    )
    op.execute(
        "INSERT INTO work_progress (job_id, data) SELECT id, '{}'::jsonb FROM jobs WHERE kind != 'PREPARE_IMAGE'"
    )


def downgrade():
    op.drop_table("work_progress")
    op.drop_table("card_prices")
    op.drop_table("data_feeds")
