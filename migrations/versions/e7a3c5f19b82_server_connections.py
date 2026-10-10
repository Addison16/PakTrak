"""Connections to other PakTrak servers, and friends on them."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "e7a3c5f19b82"
down_revision = "c4f2e8a1d905"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "server_federation",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("private_key", sa.String(64), nullable=False),
        sa.Column("public_key", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 1", name="server_federation_singleton"),
    )
    op.create_table(
        "federation_peers",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("url", sa.String(255), nullable=False, unique=True),
        sa.Column("public_key", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("connected_at", sa.DateTime(timezone=True)),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("misses", sa.Integer(), nullable=False),
        sa.Column("misses_since", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "state IN ('requested','pending','connected')", name="federation_peer_state_valid"
        ),
    )
    op.create_table(
        "federation_nonces",
        sa.Column("nonce", sa.String(64), primary_key=True),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False, index=True),
    )
    op.create_table(
        "remote_friendships",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "owner_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "peer_id",
            UUID(as_uuid=True),
            sa.ForeignKey("federation_peers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("link_id", UUID(as_uuid=True), nullable=False),
        sa.Column("remote_user", UUID(as_uuid=True)),
        sa.Column("remote_name", sa.String(255)),
        sa.Column("sent_by_owner", sa.Boolean(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("shares_collection", sa.Boolean(), nullable=False),
        sa.Column("shares_wishlist", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("peer_id", "link_id"),
        sa.CheckConstraint("state IN ('pending','accepted')", name="remote_friendship_state_valid"),
    )
    op.create_index(
        "remote_friendship_person",
        "remote_friendships",
        ["owner_id", "peer_id", "remote_user"],
        unique=True,
        postgresql_where=sa.text("remote_user IS NOT NULL"),
    )


def downgrade():
    op.drop_table("remote_friendships")
    op.drop_table("federation_nonces")
    op.drop_table("federation_peers")
    op.drop_table("server_federation")
