"""Let decks carry an Archenemy scheme deck as its own section."""

from alembic import op

revision = "a3e9d7c41b26"
down_revision = "e7a3c5f19b82"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("deck_card_valid_section", "deck_cards", type_="check")
    op.create_check_constraint(
        "deck_card_valid_section",
        "deck_cards",
        "section IN ('main','sideboard','commander','schemes')",
    )


def downgrade():
    op.execute("DELETE FROM deck_cards WHERE section = 'schemes'")
    op.drop_constraint("deck_card_valid_section", "deck_cards", type_="check")
    op.create_check_constraint(
        "deck_card_valid_section", "deck_cards", "section IN ('main','sideboard','commander')"
    )
