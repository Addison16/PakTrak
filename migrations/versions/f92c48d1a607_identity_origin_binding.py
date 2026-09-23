"""Remember the identity realm across public hostname changes."""

import sqlalchemy as sa
from alembic import op

revision = "f92c48d1a607"
down_revision = "e83d21a7b690"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "identity_binding",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("realm_id", sa.String(255), nullable=False),
        sa.Column("issuer", sa.String(512), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 1", name="identity_binding_singleton"),
    )


def downgrade():
    op.drop_table("identity_binding")
