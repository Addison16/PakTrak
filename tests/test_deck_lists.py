import csv
import io
import secrets
import uuid

import pytest
from sqlalchemy import delete, event
from test_collections import commit, key, preview

from scanner import card_images, decks_api
from scanner.db import session_factory
from scanner.deck_lists import preview_list
from scanner.models import CatalogSnapshot, Printing


@pytest.fixture(scope="module")
def deck_catalog(isolated_database):
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic deck import tests", checksum=secrets.token_hex(32), printings=7
        )
        db.add(snapshot)
        db.flush()
        ids = [uuid.uuid4() for _ in range(7)]
        oracle = uuid.uuid4()
        for index, name in enumerate(
            [
                "Deck Fixture Ember",
                "Deck Fixture Ember",
                "Deck Fixture Water",
                "Deck Fixture Front // Deck Fixture Back",
                '=Deck Formula, "quoted"',
                "Deck Fixture Ember // Deck Fixture Ember",
                "Deck Fixture Ember // Deck Fixture Ember",
            ]
        ):
            db.add(
                Printing(
                    id=ids[index],
                    oracle_id=oracle if index < 2 else uuid.uuid4(),
                    name=name,
                    set_code="alt" if index == 1 else "tst",
                    collector_number=str(index + 1),
                    language="en",
                    finishes=["nonfoil", "foil"],
                    snapshot_id=snapshot.id,
                    source_json={
                        "card_faces": [
                            {"name": "Deck Fixture Front"},
                            {"name": "Deck Fixture Back"},
                        ]
                    }
                    if index == 3
                    else {"printed_name": "Carte Fixture Eau"}
                    if index == 2
                    else {"layout": "art_series"}
                    if index == 5
                    else {"layout": "reversible_card"}
                    if index == 6
                    else {},
                )
            )
        snapshot_id = snapshot.id
    yield [str(value) for value in ids]
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_(ids)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def deck_preview(client, content, file_format="text"):
    return client.post(
        "/api/v1/decks/import-preview",
        json={"content": content, "file_format": file_format},
        headers=key(),
    )


def make_deck(client, ids, mode="any", headers=None):
    return client.post(
        "/api/v1/decks",
        headers=headers or key(),
        json={
            "name": "Planned deck",
            "match_mode": mode,
            "cards": [
                {"printing_id": ids[0], "quantity": 1, "section": "commander"},
                {"printing_id": ids[1], "quantity": 2, "section": "main"},
                {"printing_id": ids[2], "quantity": 4, "section": "main"},
                {"printing_id": ids[2], "quantity": 1, "section": "sideboard"},
            ],
        },
    )


def test_deck_text_preview_preserves_sections_printings_and_unmatched_lines(clients, deck_catalog):
    client, _ = clients()
    result = deck_preview(
        client,
        "\ufeffCommander\n1 Deck Fixture Ember (TST) 1\n// Mainboard\n2x Deck Fixture Ember [ALT] 2\n4 Deck Fixture Water\nSB: 1 Deck Fixture Water\n1 Misspelled card\n",
    ).json()
    assert result["unresolved"] == 1 and result["copies"] == 9
    assert [row["section"] for row in result["items"]] == [
        "commander",
        "main",
        "main",
        "sideboard",
        "main",
    ]
    assert [row["printing"]["id"] for row in result["items"][:2]] == deck_catalog[:2]
    assert result["items"][-1]["line"] == 7
    assert result["items"][-1]["error"] and result["items"][-1]["can_choose"]
    assert client.get("/api/v1/decks").json()["items"] == []
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0
    front = deck_preview(client, "1 Deck Fixture Front").json()["items"][0]
    assert front["printing"]["id"] == deck_catalog[3]
    named = deck_preview(client, "1 Deck Fixture Ember").json()["items"][0]
    assert named["printing"]["id"] in deck_catalog[:2]
    art = deck_preview(client, "1 Deck Fixture Ember (TST) 6").json()["items"][0]
    assert art["printing"]["id"] == deck_catalog[5]
    reversible = deck_preview(client, "1 Deck Fixture Ember (TST) 7").json()["items"][0]
    assert reversible["printing"]["id"] == deck_catalog[6]


def test_deck_csv_import_aliases_identifiers_and_bad_rows(clients, deck_catalog):
    client, _ = clients()
    response = deck_preview(
        client,
        "Card,Qty,Set,Collector Number,Board\nDeck Fixture Ember,2,ALT,2,Sideboard\nDeck Fixture Water,0,,,main\nDeck Fixture Water,1,,,maybeboard\n",
        "csv",
    )
    assert response.status_code == 200, response.text
    rows = response.json()["items"]
    assert rows[0]["printing"]["id"] == deck_catalog[1] and rows[0]["section"] == "sideboard"
    assert rows[1]["error"] and not rows[1]["can_choose"]
    assert rows[2]["error"] and not rows[2]["can_choose"]
    conflict = deck_preview(
        client, f"Scryfall ID,Name,Quantity\n{deck_catalog[0]},Deck Fixture Water,1\n", "csv"
    ).json()
    assert conflict["items"][0]["error"] == "Card name conflicts with the supplied printing ID."
    assert deck_preview(client, "Unrecognized,Header\na,b\n", "csv").status_code == 422
    assert deck_preview(client, "1 Deck Fixture Water\n" * 301).status_code == 422
    assert deck_preview(client, "a" * (256 * 1024 + 1)).status_code == 422


def test_whole_deck_names_and_aliases_use_bounded_catalog_queries(deck_catalog):
    queries = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        if "FROM card_printings" in statement:
            queries.append(statement)

    content = "1 deck fixture front\n1 CARTE FIXTURE EAU\n1 Deck Fixture Ember (ALT) 2\n"
    content += "\n".join(f"1 Unknown deck fixture {index}" for index in range(100))
    with session_factory()() as db:
        connection = db.connection()
        event.listen(connection, "before_cursor_execute", capture)
        try:
            result = preview_list(db, content, "text")
        finally:
            event.remove(connection, "before_cursor_execute", capture)
    assert len(queries) <= 2
    assert result["unresolved"] == 100
    assert [row["printing"]["id"] for row in result["items"][:3]] == [
        deck_catalog[3],
        deck_catalog[2],
        deck_catalog[1],
    ]


def test_missing_copies_are_allocated_once_across_sections_and_printings(clients, deck_catalog):
    client, _ = clients()
    outsider, _ = clients()
    commit(
        client,
        preview(
            client,
            [
                {"Scryfall ID": deck_catalog[0], "Quantity": "2", "Binder Name": "Red binder"},
                {"Scryfall ID": deck_catalog[2], "Quantity": "3", "Binder Name": "Box 4"},
            ],
        ),
    )
    request_key = key()
    response = make_deck(client, deck_catalog, headers=request_key)
    assert response.status_code == 201, response.text
    deck = response.json()
    assert (deck["copies"], deck["owned_copies"], deck["missing_copies"]) == (8, 5, 3)
    assert sum(card["available"] for card in deck["cards"]) == 5
    assert sum(card["missing"] for card in deck["cards"]) == 3
    assert deck["cards"][0]["section"] == "commander" and deck["cards"][0]["available"] == 1
    assert {location["name"] for card in deck["cards"] for location in card["locations"]} == {
        "Red binder",
        "Box 4",
    }
    assert make_deck(client, deck_catalog, headers=request_key).json()["id"] == deck["id"]
    assert make_deck(client, deck_catalog, "exact", request_key).status_code == 409
    path = f"/api/v1/decks/{deck['id']}/buy-list"
    for fmt in ["text", "cardkingdom", "tcgplayer", "manapool"]:
        result = client.get(path, params={"format": fmt})
        assert result.status_code == 200
        assert result.text == "1 Deck Fixture Ember\n2 Deck Fixture Water\n"
        assert result.headers["cache-control"] == "private, no-store"
        assert result.headers["content-disposition"].endswith(f'-{fmt}.txt"')
    csv_rows = list(
        csv.DictReader(io.StringIO(client.get(path + "?format=csv").content.decode("utf-8-sig")))
    )
    assert [row["Quantity"] for row in csv_rows] == ["1", "2"]
    assert all(not row["Scryfall ID"] for row in csv_rows)  # any printing is acceptable
    assert outsider.get(path).status_code == 404
    assert outsider.get(f"/api/v1/decks/{deck['id']}").status_code == 404
    foreign = make_deck(outsider, deck_catalog).json()
    assert foreign["owned_copies"] == 0 and foreign["missing_copies"] == 8
    assert client.get("/api/v1/collection").json()["copies"] == 5
    exact = make_deck(client, deck_catalog, "exact").json()
    assert (exact["owned_copies"], exact["missing_copies"]) == (4, 4)
    mp = client.get(f"/api/v1/decks/{exact['id']}/buy-list?format=manapool").text
    assert mp == "2 Deck Fixture Ember (ALT) 2\n2 Deck Fixture Water (TST) 3\n"
    ck = client.get(f"/api/v1/decks/{exact['id']}/buy-list?format=cardkingdom").text
    assert ck == "2 Deck Fixture Ember\n2 Deck Fixture Water\n"
    tcg = client.get(f"/api/v1/decks/{exact['id']}/buy-list?format=tcgplayer")
    assert tcg.status_code == 200
    assert tcg.text == "2 Deck Fixture Ember [ALT] 2\n2 Deck Fixture Water [TST] 3\n"


def test_deck_and_csv_exports_roundtrip_and_purchase_lists_refresh_holdings(clients, deck_catalog):
    client, _ = clients()
    deck = make_deck(client, deck_catalog, "exact").json()
    for fmt in ["text", "csv"]:
        exported = client.get(f"/api/v1/decks/{deck['id']}/download?format={fmt}").content.decode(
            "utf-8-sig"
        )
        imported = deck_preview(client, exported, fmt).json()
        assert imported["unresolved"] == 0 and imported["copies"] == 8
        assert {row["section"] for row in imported["items"]} == {"main", "sideboard", "commander"}
    commit(
        client,
        preview(
            client,
            [
                {"Scryfall ID": deck_catalog[0], "Quantity": "1"},
                {"Scryfall ID": deck_catalog[1], "Quantity": "2"},
                {"Scryfall ID": deck_catalog[2], "Quantity": "5"},
            ],
        ),
    )
    assert client.get(f"/api/v1/decks/{deck['id']}").json()["missing_copies"] == 0
    assert client.get(f"/api/v1/decks/{deck['id']}/buy-list").status_code == 409
    lot = client.get("/api/v1/collection").json()["items"][0]
    assert (
        client.post(
            f"/api/v1/collection/{lot['id']}/quantity",
            headers=key(),
            json={"expected_version": lot["version"], "quantity": 0},
        ).status_code
        == 200
    )
    assert client.get(f"/api/v1/decks/{deck['id']}/buy-list").status_code == 200
    bad = client.post(
        f"/api/v1/decks/{deck['id']}",
        headers=key(),
        json={
            "name": "Broken",
            "expected_version": deck["version"],
            "cards": [{"printing_id": str(uuid.uuid4()), "quantity": 1}],
        },
    )
    assert bad.status_code == 422
    assert client.get(f"/api/v1/decks/{deck['id']}").json()["copies"] == 8


def test_buy_csv_is_safe_and_exact_identifiers_are_preserved(clients, deck_catalog):
    client, _ = clients()
    deck = client.post(
        "/api/v1/decks",
        headers=key(),
        json={
            "name": "Quoted names",
            "match_mode": "exact",
            "cards": [{"printing_id": deck_catalog[4], "quantity": 2}],
        },
    ).json()
    response = client.get(f"/api/v1/decks/{deck['id']}/buy-list?format=csv")
    row = next(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert row["Name"] == '\'=Deck Formula, "quoted"'
    assert row["Quantity"] == "2" and row["Scryfall ID"] == deck_catalog[4]
    assert row["Match Mode"] == "exact"


def test_deck_list_has_bounded_distinct_previews_and_owned_pagination(
    clients, deck_catalog, monkeypatch
):
    client, _ = clients()
    outsider, _ = clients()
    old = make_deck(client, deck_catalog).json()
    for index in range(20):
        result = client.post(
            "/api/v1/decks",
            headers=key(),
            json={
                "name": f"Preview deck {index}",
                "cards": [
                    {"printing_id": card, "quantity": 4, "section": "main"} for card in deck_catalog
                ]
                + [{"printing_id": deck_catalog[-1], "quantity": 1, "section": "commander"}],
            },
        )
        assert result.status_code == 201
    serialized = []
    original = decks_api.printing_json

    def track(card):
        serialized.append(card.id)
        return original(card)

    monkeypatch.setattr(decks_api, "printing_json", track)
    listing = client.get("/api/v1/decks").json()
    assert listing["next_offset"] == 20 and len(listing["items"]) == 20
    assert len(serialized) == 120
    for deck in listing["items"]:
        assert deck["copies"] == 29 and deck["unique_printings"] == 7
        assert len(deck["preview_cards"]) == 6
        assert len({card["id"] for card in deck["preview_cards"]}) == 6
        assert deck["preview_cards"][0]["id"] == deck_catalog[-1]  # commander first
        assert "cards" not in deck  # do not transfer full card lists/catalog JSON to list pages
    older = client.get("/api/v1/decks?offset=20").json()
    assert older["next_offset"] is None and older["items"][0]["id"] == old["id"]
    assert outsider.get("/api/v1/decks").json()["items"] == []


@pytest.mark.parametrize("size", ["grid", "art"])
def test_planned_card_images_require_an_owned_active_deck(clients, deck_catalog, monkeypatch, size):
    client, _ = clients()
    outsider, _ = clients()
    path = f"/api/v1/card-images/{deck_catalog[0]}/0/{size}"
    loaded = []

    def load(card, face, size):
        loaded.append(card.id)
        return b"synthetic image", "image/png", "test-digest"

    monkeypatch.setattr(card_images, "load_image", load)
    assert client.get(path).status_code == 404
    deck = make_deck(client, deck_catalog).json()
    assert outsider.get(path).status_code == 404
    image = client.get(path)
    assert image.status_code == 200 and image.content == b"synthetic image"
    assert image.headers["cache-control"].startswith("private")
    assert len(loaded) == 1
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert (
        client.post(
            f"/api/v1/decks/{deck['id']}/archive",
            headers=key(),
            json={"expected_version": deck["version"]},
        ).status_code
        == 200
    )
    assert client.get(path).status_code == 404
    assert client.get("/api/v1/decks").json()["items"] == []


def test_existing_deck_list_updates_preserve_identity_and_reject_stale_or_invalid_edits(
    clients, deck_catalog
):
    client, _ = clients()
    outsider, _ = clients()
    deck = make_deck(client, deck_catalog).json()
    path = f"/api/v1/decks/{deck['id']}"
    headers = key()
    replacement = {
        "name": deck["name"],
        "format": "commander",
        "notes": "Keep this deck's sleeves",
        "match_mode": "exact",
        "expected_version": deck["version"],
        "cards": [{"printing_id": deck_catalog[2], "quantity": 3, "section": "main"}],
    }
    assert outsider.post(path, headers=headers, json=replacement).status_code == 404
    updated = client.post(path, headers=headers, json=replacement).json()
    assert updated["id"] == deck["id"] and updated["copies"] == 3
    assert len(client.get("/api/v1/decks").json()["items"]) == 1
    assert (
        client.post(path, headers=headers, json=replacement).json()["version"] == updated["version"]
    )
    assert client.post(path, headers=key(), json=replacement).status_code == 409
    appended = {
        **replacement,
        "expected_version": updated["version"],
        "cards": [
            {"printing_id": deck_catalog[2], "quantity": 5, "section": "main"},
            {"printing_id": deck_catalog[2], "quantity": 1, "section": "sideboard"},
        ],
    }
    saved = client.post(path, headers=key(), json=appended).json()
    assert saved["copies"] == 6 and saved["version"] == updated["version"] + 1
    assert saved["notes"] == replacement["notes"] and saved["match_mode"] == "exact"
    invalid = {
        **appended,
        "expected_version": saved["version"],
        "cards": [
            {"printing_id": deck_catalog[2], "quantity": 100001, "section": "main"},
        ],
    }
    assert client.post(path, headers=key(), json=invalid).status_code == 422
    assert client.get(path).json()["copies"] == 6
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0
