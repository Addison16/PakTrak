"""Draft comparison and repairable deck import regression coverage."""

import uuid

from test_collections import commit, key, preview
from test_deck_lists import deck_catalog as deck_catalog


def test_live_draft_ownership_allocates_each_copy_once_without_saving(clients, deck_catalog):
    client, _ = clients()
    other, _ = clients()
    commit(
        client,
        preview(
            client, [{"Scryfall ID": deck_catalog[0], "Quantity": "2", "Binder Name": "Deck box"}]
        ),
    )
    body = {
        "match_mode": "any",
        "cards": [
            {"printing_id": deck_catalog[0], "quantity": 1, "section": "commander"},
            {"printing_id": deck_catalog[1], "quantity": 2, "section": "main"},
            {"printing_id": deck_catalog[0], "quantity": 1, "section": "sideboard"},
        ],
    }
    response = client.post("/api/v1/decks/collection-preview", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert (result["copies"], result["owned_copies"], result["missing_copies"]) == (4, 2, 2)
    assert [card["available"] for card in result["cards"]] == [1, 1, 0]
    assert all(card["locations"][0]["name"] == "Deck box" for card in result["cards"])
    assert all(card["needed_in_deck"] == 4 for card in result["cards"])
    exact = client.post(
        "/api/v1/decks/collection-preview", json={**body, "match_mode": "exact"}
    ).json()
    assert [card["available"] for card in exact["cards"]] == [1, 0, 1]
    foreign = other.post("/api/v1/decks/collection-preview", json=body).json()
    assert foreign["owned_copies"] == 0 and all(not card["locations"] for card in foreign["cards"])
    assert client.get("/api/v1/decks").json()["items"] == []
    assert client.get("/api/v1/collection").json()["copies"] == 2
    invalid = {"cards": [{"printing_id": str(uuid.uuid4()), "quantity": 1}]}
    assert client.post("/api/v1/decks/collection-preview", json=invalid).status_code == 422
    assert client.post("/api/v1/decks/collection-preview", json={"cards": []}).json()["copies"] == 0


def test_invalid_quantity_and_section_still_resolve_printings_for_inline_repair(
    clients, deck_catalog
):
    client, _ = clients()
    content = "Name,Quantity,Section\nDeck Fixture Ember,0,main\nDeck Fixture Water,2,wrong\nNo such card,3,main\n"
    body = {"content": content, "file_format": "csv"}
    response = client.post("/api/v1/decks/import-preview", headers=key(), json=body)
    assert response.status_code == 200, response.text
    rows = response.json()["items"]
    assert rows[0]["printing"] and rows[0]["quantity_error"] and not rows[0]["identity_error"]
    assert rows[1]["printing"]["id"] == deck_catalog[2] and rows[1]["section_error"]
    assert rows[2]["identity_error"] and not rows[2]["quantity_error"]
    inserted = client.post(
        "/api/v1/decks/import-preview",
        headers=key(),
        json={
            **body,
            "content": content.replace(
                "Name,Quantity,Section\n", "Name,Quantity,Section\nDeck Fixture Water,1,sideboard\n"
            ),
        },
    ).json()["items"]
    assert [row["source_key"] for row in rows] == [row["source_key"] for row in inserted[1:]]
    assert client.get("/api/v1/decks").json()["items"] == []


def test_duplicate_import_rows_have_independently_recoverable_source_keys(clients, deck_catalog):
    client, _ = clients()
    body = {"content": "1 Deck Fixture Ember\n1 Deck Fixture Ember", "file_format": "text"}
    rows = client.post("/api/v1/decks/import-preview", headers=key(), json=body).json()["items"]
    assert rows[0]["source_key"] != rows[1]["source_key"]
    inserted = client.post(
        "/api/v1/decks/import-preview",
        headers=key(),
        json={**body, "content": "1 Deck Fixture Water\n" + body["content"]},
    ).json()["items"]
    assert [row["source_key"] for row in rows] == [row["source_key"] for row in inserted[1:]]
