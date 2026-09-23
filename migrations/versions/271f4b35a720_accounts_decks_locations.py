"""Account roles, lifetime scan allowance, saved decks, and storage locations."""

import sqlalchemy as sa
from alembic import op

revision = "271f4b35a720"
down_revision = "756dc6210905"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "account_policy",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("guest_signup_enabled", sa.Boolean(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint("id = 1", name="account_policy_singleton"),
    )
    op.execute("INSERT INTO account_policy VALUES (1, true, 1)")
    op.add_column("users", sa.Column("role", sa.String(16), nullable=False, server_default="guest"))
    op.add_column(
        "users", sa.Column("scan_cards_used", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("users", sa.Column("approved_at", sa.DateTime(timezone=True)))
    # Existing collectors keep access. Only the former explicitly provisioned owner
    # is eligible for migration to admin; never promote an arbitrary early signup.
    op.execute("UPDATE users SET role = 'member'")
    op.execute("""UPDATE users SET role = 'admin' WHERE id = (
        SELECT id FROM users WHERE display_name = 'owner' ORDER BY created_at LIMIT 1
    )""")
    op.execute("""UPDATE users SET scan_cards_used = (
        SELECT count(*) FROM observations JOIN scans ON scans.id = observations.scan_id
        WHERE scans.owner_id = users.id
    )""")
    op.create_check_constraint("user_valid_role", "users", "role IN ('admin','member','guest')")
    op.create_check_constraint("user_scan_cards_nonnegative", "users", "scan_cards_used >= 0")
    op.add_column(
        "binders", sa.Column("kind", sa.String(16), nullable=False, server_default="binder")
    )
    op.add_column("binders", sa.Column("notes", sa.String(1024), nullable=False, server_default=""))
    op.add_column("binders", sa.Column("version", sa.Integer(), nullable=False, server_default="1"))
    op.create_table(
        "decks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("format", sa.String(32), nullable=False),
        sa.Column("notes", sa.String(4096), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("last_edit_key", sa.String(128)),
        sa.Column("last_edit_hash", sa.String(64)),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("owner_id", "request_key"),
    )
    op.create_index("ix_decks_owner_id", "decks", ["owner_id"])
    op.create_table(
        "deck_cards",
        sa.Column(
            "deck_id", sa.Uuid(), sa.ForeignKey("decks.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("printing_id", sa.Uuid(), sa.ForeignKey("card_printings.id"), primary_key=True),
        sa.Column("section", sa.String(16), primary_key=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "quantity > 0 AND quantity <= 100000", name="deck_card_positive_quantity"
        ),
        sa.CheckConstraint(
            "section IN ('main','sideboard','commander')", name="deck_card_valid_section"
        ),
    )


def downgrade():
    raise RuntimeError("Restore a coordinated backup to roll back accounts and decks.")
