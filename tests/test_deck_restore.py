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
    client.post(
        "/api/v1/decks",
        headers=key(),
        json={
            "name": "Empty idea",
            "format": "modern",
            "cards": [{"printing_id": deck_catalog[2], "quantity": 4, "section": "main"}],
        },
    )

    download = client.get("/api/v1/decks/download-all")
    assert download.status_code == 200
    content = download.content.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(content)))
    assert {row["Deck"] for row in rows} == {"'=Formula deck", "Empty idea"}
    assert len({row["Deck ID"] for row in rows}) == 3
    assert other.get("/api/v1/decks/download-all").content.decode("utf-8-sig").count("\n") == 1

    result = other.post("/api/v1/decks/restore", headers=key(), json={"content": content})
    assert result.status_code == 200, result.text
    body = result.json()
    assert sorted(deck["name"] for deck in body["restored"]) == [
        "=Formula deck",
        "Empty idea",
        "Empty idea",
    ]
    assert sorted(deck["copies"] for deck in body["restored"]) == [0, 4, 6]
    assert body["skipped"] == [] and body["problem_count"] == 0

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
    # Deck order follows the database collation, which differs between installs.
    assert "# =Formula deck\nFormat: commander\nNotes: Sleeved in red\n" in text
    assert "\nCommander\n1 Deck Fixture Ember (TST) 1\n" in text
    assert "\nSideboard\n2 Deck Fixture Water (TST) 3\n" in text
    assert "# Empty idea\nFormat: casual\n\nNo cards yet.\n" in text

    again = other.post("/api/v1/decks/restore", headers=key(), json={"content": content}).json()
    assert again["restored"] == []
    assert sorted(again["skipped"]) == ["=Formula deck", "Empty idea", "Empty idea"]


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
    assert body["problem_count"] == 1

    wrong = client.post(
        "/api/v1/decks/restore",
        headers=key(),
        json={"content": "Name,Quantity\nDeck Fixture Water,1\n"},
    )
    assert wrong.status_code == 422


def test_scheme_deck_section_saves_lists_exports_imports_and_restores(clients, deck_catalog):
    client, _ = clients()
    other, _ = clients()
    deck = client.post(
        "/api/v1/decks",
        headers=key(),
        json={
            "name": "Villain",
            "format": "commander",
            "cards": [
                {"printing_id": deck_catalog[0], "quantity": 1, "section": "commander"},
                {"printing_id": deck_catalog[2], "quantity": 2, "section": "schemes"},
            ],
        },
    )
    assert deck.status_code == 201, deck.text
    body = deck.json()
    assert body["legality"]["archenemy"] and body["legality"]["counts"]["schemes"] == 2
    assert body["valuation"]["sections"]["schemes"]["copies"] == 2
    listed = client.get("/api/v1/decks").json()["items"][0]
    assert (listed["copies"], listed["scheme_copies"]) == (3, 2)

    text = client.get(f"/api/v1/decks/{body['id']}/download").text
    assert "Schemes\n2 Deck Fixture Water (TST) 3\n" in text
    assert "Schemes\n" in client.get("/api/v1/decks/download-all?format=text").text
    preview = client.post(
        "/api/v1/decks/import-preview",
        headers=key(),
        json={"content": "Commander\n1 Deck Fixture Ember\n\nScheme deck\n2 Deck Fixture Water"},
    ).json()
    assert [row["section"] for row in preview["items"]] == ["commander", "schemes"]

    content = client.get("/api/v1/decks/download-all").content.decode("utf-8-sig")
    restored = other.post("/api/v1/decks/restore", headers=key(), json={"content": content})
    assert restored.status_code == 200 and restored.json()["problem_count"] == 0
    _, cards = deck_cards(other, restored.json()["restored"][0]["id"])
    assert cards == deck_cards(client, body["id"])[1]
