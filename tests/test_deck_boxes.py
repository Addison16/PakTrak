import secrets
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import delete
from test_collections import key

from scanner.card_images import source_image
from scanner.db import session_factory
from scanner.models import CatalogSnapshot, Printing


@pytest.fixture(scope="module")
def box_catalog(isolated_database):
    metadata = {
        "commander": ("W", "Legendary Creature — Human"),
        "partner": ("UB", "Legendary Creature — Merfolk"),
        "spell": ("R", "Instant"),
        "land": ("R", "Basic Land — Mountain"),
        "rock": ("", "Artifact"),
        "unknown": (None, "Creature"),
        "green": ("G", "Creature — Elf"),
        **{f"filler{index}": ("R", "Creature — Goblin") for index in range(6)},
    }
    ids = {name: uuid.uuid4() for name in metadata}
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic deck box tests", checksum=secrets.token_hex(32), printings=len(ids)
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        for name, (colors, type_line) in metadata.items():
            raw = {"type_line": type_line}
            if colors is not None:
                raw["color_identity"] = list(colors)
                raw["image_uris"] = {
                    "art_crop": f"https://cards.scryfall.io/art_crop/front/a/b/{ids[name]}.jpg",
                    "normal": f"https://cards.scryfall.io/normal/front/a/b/{ids[name]}.jpg",
                }
            db.add(
                Printing(
                    id=ids[name],
                    oracle_id=uuid.uuid4(),
                    name=f"Box Fixture {name}",
                    set_code="box",
                    collector_number=name,
                    language="en",
                    finishes=["nonfoil"],
                    snapshot_id=snapshot_id,
                    source_json=raw,
                )
            )
    yield {name: str(value) for name, value in ids.items()}
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_(ids.values())))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def create_box(client, catalog, cards, format="casual"):
    response = client.post(
        "/api/v1/decks",
        headers=key(),
        json={
            "name": "Test deck box",
            "format": format,
            "cards": [
                {"printing_id": catalog[name], "quantity": quantity, "section": section}
                for name, quantity, section in cards
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_box_color_uses_entire_mainboard_and_cover_prefers_nonland_copies(clients, box_catalog):
    client, _ = clients()
    create_box(
        client,
        box_catalog,
        [
            ("spell", 4, "main"),
            ("land", 30, "main"),
            ("green", 1, "main"),
            ("partner", 15, "sideboard"),
            ("green", 100, "sideboard"),
            *[(f"filler{index}", 2, "main") for index in range(6)],
        ],
        "modern",
    )
    deck = client.get("/api/v1/decks").json()["items"][0]
    assert deck["colors"] == ["R", "G"] and deck["colors_known"]
    assert len(deck["preview_cards"]) == 6
    assert box_catalog["green"] not in [card["id"] for card in deck["preview_cards"]]
    assert [card["id"] for card in deck["cover_cards"]] == [box_catalog["spell"]]
    assert deck["cover_cards"][0]["art_url"] == f"/api/v1/card-images/{box_catalog['spell']}/0/art"
    assert deck["cover_cards"][0]["section"] == "main"
    assert deck["copies"] == 162 and deck["unique_printings"] == 10
    assert "cards" not in deck
    assert client.get("/api/v1/collection").json()["copies"] == 0


def test_commander_box_features_both_commanders_and_refreshes_after_edit(clients, box_catalog):
    client, _ = clients()
    saved = create_box(
        client,
        box_catalog,
        [
            ("spell", 4, "main"),
            ("commander", 1, "commander"),
            ("partner", 1, "commander"),
        ],
        "commander",
    )
    summary = client.get("/api/v1/decks").json()["items"][0]
    assert summary["colors"] == ["W", "U", "B", "R"]
    assert {card["id"] for card in summary["cover_cards"]} == {
        box_catalog["commander"],
        box_catalog["partner"],
    }
    assert all(card["section"] == "commander" for card in summary["cover_cards"])
    response = client.post(
        f"/api/v1/decks/{saved['id']}",
        headers=key(),
        json={
            "name": saved["name"],
            "format": "commander",
            "expected_version": saved["version"],
            "cards": [
                {"printing_id": box_catalog["partner"], "section": "commander", "quantity": 1}
            ],
        },
    )
    assert response.status_code == 200, response.text
    summary = client.get("/api/v1/decks").json()["items"][0]
    assert summary["colors"] == ["U", "B"]
    assert [card["id"] for card in summary["cover_cards"]] == [box_catalog["partner"]]


def test_box_handles_colorless_missing_metadata_and_unselected_commanders(clients, box_catalog):
    client, _ = clients()
    for cards, format, colors, known, covers in [
        ([], "casual", [], True, []),
        ([("rock", 1, "main")], "casual", [], True, ["rock"]),
        ([("unknown", 1, "main")], "casual", [], False, ["unknown"]),
        ([("spell", 4, "main")], "commander", ["R"], True, []),
        ([("land", 30, "main")], "casual", ["R"], True, ["land"]),
    ]:
        saved = create_box(client, box_catalog, cards, format)
        summary = next(
            deck
            for deck in client.get("/api/v1/decks").json()["items"]
            if deck["id"] == saved["id"]
        )
        assert summary["colors"] == colors and summary["colors_known"] is known
        assert [card["id"] for card in summary["cover_cards"]] == [
            box_catalog[name] for name in covers
        ]
        if covers == ["unknown"]:
            assert summary["cover_cards"][0]["art_url"] is None


def test_box_art_uses_catalog_art_crop_with_normal_and_face_fallbacks():
    card_id = uuid.uuid4()
    art = f"https://cards.scryfall.io/art_crop/front/a/b/{card_id}.jpg"
    normal = f"https://cards.scryfall.io/normal/front/a/b/{card_id}.jpg"
    card = SimpleNamespace(
        id=card_id, source_json={"image_uris": {"art_crop": art, "normal": normal}}
    )
    assert source_image(card, 0, "art") == art
    assert source_image(card, 0, "grid") == normal
    card.source_json = {"image_uris": {"normal": normal}}
    assert source_image(card, 0, "art") == normal
    card.source_json = {"card_faces": [{"image_uris": {"art_crop": art}}]}
    assert source_image(card, 0, "art") == art
    assert source_image(card, 1, "art") is None
    for unsafe in [
        f"https://localhost/{card_id}.jpg",
        f"http://cards.scryfall.io/{card_id}.jpg",
        art.replace(str(card_id), str(uuid.uuid4())),
    ]:
        card.source_json = {"image_uris": {"art_crop": unsafe}}
        assert source_image(card, 0, "art") is None
