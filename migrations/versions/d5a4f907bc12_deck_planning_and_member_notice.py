"""Deck comparison preference and a next-login membership welcome.

Revision ID: d5a4f907bc12
Revises: b607cd341a92
"""

import sqlalchemy as sa
from alembic import op

revision = "d5a4f907bc12"
down_revision = "b607cd341a92"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "decks", sa.Column("match_mode", sa.String(16), nullable=False, server_default="any")
    )
    op.execute("UPDATE decks SET match_mode = 'exact'")  # Preserve existing comparison semantics.
    op.create_check_constraint("deck_match_mode_valid", "decks", "match_mode IN ('any','exact')")
    op.add_column(
        "users",
        sa.Column("approval_notice_pending", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "login_sessions",
        sa.Column("approval_notice_eligible", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade():
    op.drop_column("login_sessions", "approval_notice_eligible")
    op.drop_column("users", "approval_notice_pending")
    op.drop_constraint("deck_match_mode_valid", "decks", type_="check")
    op.drop_column("decks", "match_mode")
