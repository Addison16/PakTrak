import pytest
from test_collections import key
from test_deck_lists import deck_catalog as deck_catalog


def preview(client, content, **options):
    return client.post(
        "/api/v1/decks/import-preview",
        headers=key(),
        json={
            "content": content,
            "deck_format": "commander",
            **options,
        },
    )


@pytest.mark.parametrize(
    "file_format,content",
    [
        ("text", "1 Deck Fixture Ember\n90 Deck Fixture Water\n20 Deck Fixture Front\n"),
        (
            "csv",
            "Name,Quantity\nDeck Fixture Ember,1\nDeck Fixture Water,90\nDeck Fixture Front,20\n",
        ),
        (
            "csv",
            "Name,Quantity,Section\nDeck Fixture Ember,1,\nDeck Fixture Water,90,\nDeck Fixture Front,20,\n",
        ),
    ],
)
def test_unsectioned_commander_import_splits_quantities_at_one_and_100(
    clients, deck_catalog, file_format, content
):
    client, _ = clients()
    response = preview(client, content, file_format=file_format)
    assert response.status_code == 200
    data = response.json()
    assert data["unresolved"] == 0 and data["copies"] == 111
    assert data["layout"] == {
        "applied": True,
        "reason": "commander_order",
        "counts": {"commander": 1, "main": 99, "sideboard": 11},
    }
    assert [(r["quantity"], r["section"]) for r in data["items"]] == [
        (1, "commander"),
        (90, "main"),
        (9, "main"),
        (11, "sideboard"),
    ]
    assert data["items"][2]["line"] == data["items"][3]["line"]
    assert data["items"][2]["printing"] == data["items"][3]["printing"]
    assert client.get("/api/v1/decks").json()["items"] == []
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0


def test_first_card_is_one_physical_copy_and_partner_layout_is_explicit(clients, deck_catalog):
    client, _ = clients()
    one = preview(client, "4 Deck Fixture Ember\n97 Deck Fixture Water").json()
    assert [(r["quantity"], r["section"]) for r in one["items"]] == [
        (1, "commander"),
        (3, "main"),
        (96, "main"),
        (1, "sideboard"),
    ]
    two = preview(
        client,
        "Deck Fixture Ember\nDeck Fixture Front\n100 Deck Fixture Water",
        section_mode="two_commanders",
    ).json()
    assert [(r["quantity"], r["section"]) for r in two["items"]] == [
        (1, "commander"),
        (1, "commander"),
        (98, "main"),
        (2, "sideboard"),
    ]


@pytest.mark.parametrize(
    "content,options",
    [
        ("Commander\nDeck Fixture Ember\nMainboard\n100 Deck Fixture Water", {}),
        ("// Commander\nDeck Fixture Ember\n// Mainboard\n100 Deck Fixture Water", {}),
        ("Deck Fixture Ember\nSB: 100 Deck Fixture Water", {}),
        (
            "Name,Quantity,Section\nDeck Fixture Ember,1,Commander\nDeck Fixture Water,100,Mainboard",
            {"file_format": "csv"},
        ),
    ],
)
def test_explicit_sections_are_never_silently_reassigned(clients, deck_catalog, content, options):
    client, _ = clients()
    data = preview(client, content, **options).json()
    assert data["layout"]["reason"] == "listed_sections" and not data["layout"]["applied"]
    assert len(data["items"]) == 2
    assert data["items"][1]["quantity"] == 100


def test_other_formats_and_additive_lists_remain_mainboard_and_bad_quantities_block_layout(
    clients, deck_catalog
):
    client, _ = clients()
    for options in [{"deck_format": "modern"}, {"section_mode": "listed"}]:
        data = preview(client, "101 Deck Fixture Water", **options).json()
        assert len(data["items"]) == 1 and data["items"][0]["section"] == "main"
        assert not data["layout"]["applied"]
    for count in ["0", "100001"]:
        data = preview(client, f"Deck Fixture Ember\n{count} Deck Fixture Water").json()
        assert data["unresolved"] == 1
        assert data["layout"]["reason"] == "invalid_quantities"
        assert not data["layout"]["applied"]
    unknown = preview(client, "An unknown commander\n99 Deck Fixture Water").json()
    assert unknown["items"][0]["section"] == "commander" and unknown["items"][0]["can_choose"]
    assert unknown["items"][1]["quantity"] == 99
