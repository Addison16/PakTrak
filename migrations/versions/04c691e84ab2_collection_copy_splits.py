"""Preserve inventory source lineage while moving part of a lot."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "04c691e84ab2"
down_revision = "f92c48d1a607"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("inventory_lots", sa.Column("split_parent_id", postgresql.UUID(as_uuid=True)))
    op.create_foreign_key(
        "lot_split_parent",
        "inventory_lots",
        "inventory_lots",
        ["split_parent_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_check_constraint(
        "lot_not_own_parent", "inventory_lots", "split_parent_id IS NULL OR split_parent_id <> id"
    )
    op.create_check_constraint(
        "lot_scan_cannot_split",
        "inventory_lots",
        "split_parent_id IS NULL OR source_observation_id IS NULL",
    )
    for column, name in (
        ("source_import_row_id", "lot_original_import_source"),
        ("source_observation_id", "lot_original_scan_source"),
    ):
        op.drop_constraint(f"inventory_lots_{column}_key", "inventory_lots", type_="unique")
        op.create_index(
            name,
            "inventory_lots",
            [column],
            unique=True,
            postgresql_where=sa.text("split_parent_id IS NULL"),
        )
        op.create_index(f"ix_inventory_lots_{column}", "inventory_lots", [column])
    op.create_index("ix_inventory_lots_split_parent_id", "inventory_lots", ["split_parent_id"])


def downgrade():
    # A populated lineage cannot be flattened without changing storage/metadata.
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM inventory_lots WHERE split_parent_id IS NOT NULL)")
    ):
        raise RuntimeError(
            "Collection splits exist. Restore a pre-upgrade backup to downgrade safely."
        )
    for column, name in (
        ("source_import_row_id", "lot_original_import_source"),
        ("source_observation_id", "lot_original_scan_source"),
    ):
        op.drop_index(name, table_name="inventory_lots")
        op.drop_index(f"ix_inventory_lots_{column}", table_name="inventory_lots")
        op.create_unique_constraint(f"inventory_lots_{column}_key", "inventory_lots", [column])
    op.drop_index("ix_inventory_lots_split_parent_id", table_name="inventory_lots")
    op.drop_constraint("lot_not_own_parent", "inventory_lots", type_="check")
    op.drop_constraint("lot_scan_cannot_split", "inventory_lots", type_="check")
    op.drop_constraint("lot_split_parent", "inventory_lots", type_="foreignkey")
    op.drop_column("inventory_lots", "split_parent_id")
