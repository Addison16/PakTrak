import csv
import io

from test_collections import key
from test_deck_lists import deck_catalog as deck_catalog


def deck_cards(client, deck_id):
    deck = client.get(f"/api/v1/decks/{deck_id}").json()
    return deck, sorted(
        (card["printing"]["id"], card["section"], card["quantity"]) for card in deck["cards"]
    )


def test_all_decks_download_restores_every_deck_on_another_account(clients, deck_catalog):
    client, _ = clients()
    other, _ = clients()
    full = client.post(
        "/api/v1/decks",
        headers=key(),
        json={
            "name": "=Formula deck",
            "format": "commander",
            "match_mode": "exact",
            "notes": "Sleeved in red",
            "cards": [
                {"printing_id": deck_catalog[0], "quantity": 1, "section": "commander"},
                {"printing_id": deck_catalog[4], "quantity": 3, "section": "main"},
                {"printing_id": deck_catalog[2], "quantity": 2, "section": "sideboard"},
            ],
        },
    ).json()
    client.post("/api/v1/decks", headers=key(), json={"name": "Empty idea"})

    download = client.get("/api/v1/decks/download-all")
    assert download.status_code == 200
    content = download.content.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(content)))
    assert {row["Deck"] for row in rows} == {"'=Formula deck", "Empty idea"}
    assert other.get("/api/v1/decks/download-all").content.decode("utf-8-sig").count("\n") == 1

    result = other.post("/api/v1/decks/restore", headers=key(), json={"content": content})
    assert result.status_code == 200, result.text
    body = result.json()
    assert sorted(deck["name"] for deck in body["restored"]) == ["=Formula deck", "Empty idea"]
    assert body["skipped"] == [] and body["problems"] == []

    restored = next(deck for deck in body["restored"] if deck["name"] == "=Formula deck")
    copy, cards = deck_cards(other, restored["id"])
    _, original = deck_cards(client, full["id"])
    assert cards == original
    assert (copy["format"], copy["match_mode"], copy["notes"]) == (
        "commander",
        "exact",
        "Sleeved in red",
    )

    text = client.get("/api/v1/decks/download-all?format=text").text
    assert text.startswith("# =Formula deck\nFormat: commander\nNotes: Sleeved in red\n")
    assert "\nCommander\n1 Deck Fixture Ember (TST) 1\n" in text
    assert "\nSideboard\n2 Deck Fixture Water (TST) 3\n" in text
    assert "# Empty idea\nFormat: casual\n\nNo cards yet.\n" in text

    again = other.post("/api/v1/decks/restore", headers=key(), json={"content": content}).json()
    assert again["restored"] == []
    assert sorted(again["skipped"]) == ["=Formula deck", "Empty idea"]


def test_deck_restore_reports_unknown_cards_and_rejects_other_files(clients, deck_catalog):
    client, _ = clients()
    content = (
        "Deck,Section,Quantity,Name,Scryfall ID\n"
        f"Mixed,main,2,,{deck_catalog[2]}\n"
        "Mixed,main,1,Not A Real Card,\n"
        "Mixed,mainboard,4,Deck Fixture Water,\n"
    )
    body = client.post("/api/v1/decks/restore", headers=key(), json={"content": content}).json()
    assert [deck["copies"] for deck in body["restored"]] == [6]
    assert [(problem["line"], problem["card"]) for problem in body["problems"]] == [
        (3, "Not A Real Card")
    ]

    wrong = client.post(
        "/api/v1/decks/restore",
        headers=key(),
        json={"content": "Name,Quantity\nDeck Fixture Water,1\n"},
    )
    assert wrong.status_code == 422
