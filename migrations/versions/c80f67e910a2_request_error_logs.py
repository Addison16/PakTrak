"""Keep bounded, redacted request diagnostics across Docker restarts."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "c80f67e910a2"
down_revision = "d5a4f907bc12"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "request_error_logs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("route", sa.String(255), nullable=False),
        sa.Column("status", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("summary", sa.String(255), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("context", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_request_error_logs_created_at", "request_error_logs", ["created_at"])


def downgrade():
    op.drop_table("request_error_logs")
