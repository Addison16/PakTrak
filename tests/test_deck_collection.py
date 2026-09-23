import uuid

import pytest
from test_collections import commit, key, preview
from test_deck_lists import deck_catalog as deck_catalog

from scanner.db import session_factory
from scanner.models import Printing


def own(client, printing_id, quantity=2):
    commit(
        client,
        preview(
            client,
            [{"Scryfall ID": printing_id, "Quantity": str(quantity), "Binder Name": "Red binder"}],
        ),
    )


@pytest.mark.parametrize("file_format", ["text", "csv"])
def test_import_preview_uses_owned_editions_even_with_explicit_list_identifiers(
    clients, deck_catalog, file_format
):
    client, _ = clients()
    other, _ = clients()
    own(client, deck_catalog[0])
    content = (
        "3 Deck Fixture Ember (ALT) 2"
        if file_format == "text"
        else f"Name,Quantity,Scryfall ID\nDeck Fixture Ember,3,{deck_catalog[1]}\n"
    )
    body = {"content": content, "file_format": file_format}
    url = "/api/v1/decks/import-preview"
    result = client.post(url, headers=key(), json=body).json()
    row = result["items"][0]
    assert row["printing"]["id"] == deck_catalog[0]
    assert row["quantity"] == 3 and row["collection_match"] and row["owned"] == 2
    foreign = other.post(url, headers=key(), json=body).json()["items"][0]
    assert foreign["printing"]["id"] == deck_catalog[1] and not foreign["collection_match"]
    exact = client.post(url, headers=key(), json={**body, "match_mode": "exact"}).json()["items"][0]
    assert exact["printing"]["id"] == deck_catalog[1]
    assert client.get("/api/v1/collection").json()["copies"] == 2
    assert client.get("/api/v1/decks").json()["items"] == []


@pytest.mark.parametrize(
    "case", ["owned_without_oracle", "requested_without_oracle", "different_oracles"]
)
def test_same_name_editions_count_once_even_with_missing_or_different_oracle_ids(
    clients, deck_catalog, case
):
    client, _ = clients()
    ids = [uuid.UUID(value) for value in deck_catalog[:2]]
    with session_factory()() as db, db.begin():
        original = [db.get(Printing, card_id).oracle_id for card_id in ids]
        card = db.get(Printing, ids[0] if case == "owned_without_oracle" else ids[1])
        card.oracle_id = uuid.uuid4() if case == "different_oracles" else None
    try:
        own(client, deck_catalog[0])
        result = client.post(
            "/api/v1/decks",
            headers=key(),
            json={
                "name": "Same name",
                "cards": [
                    {"printing_id": deck_catalog[0], "section": "commander", "quantity": 1},
                    {"printing_id": deck_catalog[1], "section": "main", "quantity": 2},
                ],
            },
        ).json()
        assert (result["copies"], result["owned_copies"], result["missing_copies"]) == (3, 2, 1)
        assert [card["available"] for card in result["cards"]] == [1, 1]
        assert all(card["needed_in_deck"] == 3 for card in result["cards"])
        assert client.get(f"/api/v1/decks/{result['id']}/buy-list").text == "1 Deck Fixture Ember\n"
    finally:
        with session_factory()() as db, db.begin():
            for card_id, oracle in zip(ids, original, strict=True):
                db.get(Printing, card_id).oracle_id = oracle


def test_import_save_uses_current_holdings_combines_rows_and_replays_without_rematching(
    clients, deck_catalog
):
    client, _ = clients()
    own(client, deck_catalog[0])
    body = {
        "name": "Matched deck",
        "match_mode": "any",
        "use_collection_versions": True,
        "cards": [
            {"printing_id": deck_catalog[0], "section": "main", "quantity": 1},
            {"printing_id": deck_catalog[1], "section": "main", "quantity": 2},
            {"printing_id": deck_catalog[1], "section": "sideboard", "quantity": 1},
        ],
    }
    receipt = key()
    response = client.post("/api/v1/decks", headers=receipt, json=body)
    assert response.status_code == 201, response.text
    deck = response.json()
    assert (deck["copies"], deck["owned_copies"], deck["missing_copies"]) == (4, 2, 2)
    assert [(c["printing"]["id"], c["section"], c["quantity"]) for c in deck["cards"]] == [
        (deck_catalog[0], "main", 3),
        (deck_catalog[0], "sideboard", 1),
    ]
    assert "(TST) 1" in client.get(f"/api/v1/decks/{deck['id']}/download").text
    assert client.get("/api/v1/collection").json()["copies"] == 2
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0
    own(client, deck_catalog[1], 5)
    replayed = client.post("/api/v1/decks", headers=receipt, json=body).json()
    assert replayed["id"] == deck["id"] and replayed["version"] == deck["version"]
    assert all(c["printing"]["id"] == deck_catalog[0] for c in replayed["cards"])
    assert replayed["missing_copies"] == 0
    # A new import may choose its requested edition once that edition is owned.
    next_deck = client.post(
        "/api/v1/decks", headers=key(), json={**body, "cards": body["cards"][1:]}
    ).json()
    assert all(c["printing"]["id"] == deck_catalog[1] for c in next_deck["cards"])


def test_existing_exact_deck_can_import_using_owned_editions_with_version_and_quantity_guards(
    clients, deck_catalog
):
    client, _ = clients()
    own(client, deck_catalog[0])
    deck = client.post(
        "/api/v1/decks",
        headers=key(),
        json={"name": "Saved idea", "notes": "Blue sleeves", "match_mode": "exact"},
    ).json()
    body = {
        "name": deck["name"],
        "notes": deck["notes"],
        "format": "commander",
        "match_mode": "any",
        "use_collection_versions": True,
        "expected_version": deck["version"],
        "cards": [
            {"printing_id": deck_catalog[1], "section": "main", "quantity": 2},
        ],
    }
    url = f"/api/v1/decks/{deck['id']}"
    receipt = key()
    response = client.post(url, headers=receipt, json=body)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["id"] == deck["id"] and saved["match_mode"] == "any"
    assert saved["notes"] == "Blue sleeves" and saved["missing_copies"] == 0
    assert saved["cards"][0]["printing"]["id"] == deck_catalog[0]
    assert client.post(url, headers=receipt, json=body).json()["version"] == saved["version"]
    assert client.post(url, headers=key(), json=body).status_code == 409
    oversized = {
        **body,
        "expected_version": saved["version"],
        "cards": [
            {"printing_id": value, "section": "main", "quantity": 100_000}
            for value in deck_catalog[:2]
        ],
    }
    rejected = client.post(url, headers=key(), json=oversized)
    assert rejected.status_code == 422 and "Combined quantities" in rejected.text
    assert client.get(url).json()["copies"] == 2
    assert client.get("/api/v1/collection").json()["copies"] == 2


def test_art_insert_with_same_name_does_not_fill_playable_card_requirements(clients, deck_catalog):
    client, _ = clients()
    art_id = uuid.UUID(deck_catalog[5])
    with session_factory()() as db, db.begin():
        art = db.get(Printing, art_id)
        previous = art.name
        art.name = "Deck Fixture Ember"
    try:
        own(client, deck_catalog[5], 5)
        response = client.post(
            "/api/v1/decks",
            headers=key(),
            json={
                "name": "Playable cards",
                "use_collection_versions": True,
                "cards": [{"printing_id": deck_catalog[0], "quantity": 1}],
            },
        )
        assert response.status_code == 201, response.text
        deck = response.json()
        assert deck["owned_copies"] == 0 and deck["missing_copies"] == 1
        assert deck["cards"][0]["printing"]["id"] == deck_catalog[0]
    finally:
        with session_factory()() as db, db.begin():
            db.get(Printing, art_id).name = previous


def test_unowned_list_edition_uses_most_owned_matching_edition(clients, deck_catalog):
    client, _ = clients()
    own(client, deck_catalog[0], 2)
    own(client, deck_catalog[1], 4)
    unused_id = uuid.UUID(deck_catalog[4])
    with session_factory()() as db, db.begin():
        card = db.get(Printing, unused_id)
        original = card.name, card.oracle_id
        card.name = "Deck Fixture Ember"
        card.oracle_id = db.get(Printing, uuid.UUID(deck_catalog[0])).oracle_id
    try:
        row = client.post(
            "/api/v1/decks/import-preview",
            headers=key(),
            json={"file_format": "csv", "content": f"Scryfall ID,Quantity\n{unused_id},7\n"},
        ).json()["items"][0]
        assert row["printing"]["id"] == deck_catalog[1]
        assert row["owned"] == 6 and row["quantity"] == 7
    finally:
        with session_factory()() as db, db.begin():
            card = db.get(Printing, unused_id)
            card.name, card.oracle_id = original
