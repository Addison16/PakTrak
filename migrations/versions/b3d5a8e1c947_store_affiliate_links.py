"""Optional site-wide referral codes or tracking links for store buttons."""

import sqlalchemy as sa
from alembic import op

revision = "b3d5a8e1c947"
down_revision = "04c691e84ab2"
branch_labels = None
depends_on = None

STORES = ("tcgplayer", "cardkingdom", "manapool")


def upgrade():
    for store in STORES:
        op.add_column("account_policy", sa.Column(f"{store}_affiliate", sa.String(500)))


def downgrade():
    for store in STORES:
        op.drop_column("account_policy", f"{store}_affiliate")
