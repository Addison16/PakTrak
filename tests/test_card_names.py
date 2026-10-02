"""Names printed on cards must resolve to their exact catalog printing."""

import io
import secrets
import uuid

import pytest
from PIL import Image
from sqlalchemy import delete
from test_collections import commit, preview

from scanner import recognition
from scanner.csv_formats import resolve
from scanner.db import session_factory
from scanner.deck_lists import preview_list
from scanner.models import CatalogSnapshot, Printing, User


@pytest.fixture
def named_cards(clients):
    client, owner = clients()
    other, other_owner = clients()
    definitions = [
        ("Nature's Claim", "fca", "47", "en", {"flavor_name": "Search for the Frozen Esper"}),
        ("Nature's Claim", "wwk", "108", "en", {}),
        (
            "Crystalline Giant",
            "iko",
            "376",
            "en",
            {"flavor_name": "Mechagodzilla, Battle Fortress"},
        ),
        ("Lightning Bolt", "frs", "1", "fr", {"printed_name": "Éclair"}),
        (
            "Fixture Dawn // Fixture Noon // Fixture Dusk",
            "tst",
            "5",
            "en",
            {
                "card_faces": [
                    {"name": "Fixture Dawn", "flavor_name": "Morning Hero"},
                    {"name": "Fixture Noon", "printed_name": "Midi"},
                    {
                        "name": "Fixture Dusk",
                        "flavor_name": 'Sleeping "Hero"',
                        "printed_name": "Crépuscule",
                    },
                ],
            },
        ),
        ("Literal Fixture", "tst", "6", "en", {"flavor_name": "Alias 100%_Ready\\Now"}),
        (
            "Unrelated Fixture",
            "tst",
            "7",
            "en",
            {
                "oracle_text": "Search for the Frozen Esper",
                "flavor_text": "Secret Metadata Name",
                "all_parts": [{"name": "Secret Metadata Name"}],
            },
        ),
        (
            "Empty Alias Fixture",
            "tst",
            "8",
            "en",
            {"printed_name": None, "flavor_name": None, "card_faces": None},
        ),
    ]
    cards = []
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="name alias tests", checksum=secrets.token_hex(32), printings=len(definitions)
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        for name, edition, number, language, raw in definitions:
            card = Printing(
                id=uuid.uuid4(),
                name=name,
                set_code=edition,
                collector_number=number,
                language=language,
                finishes=["nonfoil", "foil"],
                snapshot_id=snapshot_id,
                source_json={"set_name": edition.upper(), "rarity": "uncommon", **raw},
            )
            cards.append(card)
            db.add(card)
    yield client, other, cards
    with session_factory()() as db, db.begin():
        db.execute(delete(User).where(User.id.in_([owner, other_owner])))
        db.execute(delete(Printing).where(Printing.id.in_([card.id for card in cards])))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


@pytest.mark.parametrize(
    "query, index",
    [
        ("search for the frozen esper", 0),
        ("Mechagodzilla, Battle Fortress", 2),
        ("ÉCLAIR", 3),
        ("Morning Hero", 4),
        ("Midi", 4),
        ("Fixture Dusk", 4),
        ('Sleeping "Hero"', 4),
        ("Crépuscule", 4),
        ("Alias 100%_Ready\\Now", 5),
    ],
)
def test_catalog_searches_all_printed_names_without_duplicate_rows(named_cards, query, index):
    client, _, cards = named_cards
    for exact in (False, True):
        response = client.get(
            "/api/v1/catalog/search", params={"q": query, "exact_name": exact, "facets": True}
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert [item["id"] for item in result["items"]] == [str(cards[index].id)]
        assert result["next_offset"] is None
        assert result["filters"]["sets"] == [
            {"code": cards[index].set_code, "name": cards[index].set_code.upper()}
        ]
    if index == 0:
        assert result["items"][0]["name"] == "Nature's Claim"
        assert result["items"][0]["display_name"] == "Search for the Frozen Esper"


def test_alias_search_preserves_identifiers_filters_and_literal_text(named_cards):
    client, _, cards = named_cards
    for query in ("Frozen Esper", "Search for the Frozen Esper #47", str(cards[0].id)):
        result = client.get(
            "/api/v1/catalog/search",
            params={"q": query, "set_code": "FCA", "rarity": "uncommon", "language": "en"},
        ).json()
        assert [item["id"] for item in result["items"]] == [str(cards[0].id)]
    canonical = client.get(
        "/api/v1/catalog/search", params={"q": "Nature's Claim", "exact_name": True}
    ).json()
    assert {item["id"] for item in canonical["items"]} == {str(card.id) for card in cards[:2]}
    for params in (
        {"q": "Search for the Frozen Esper #48"},
        {"q": "Search for the Frozen Esper", "set_code": "wwk"},
        {"q": "Search for the Frozen Esper", "language": "fr"},
        {"q": "Search for the Frozen Esper", "collector_number": "108"},
        {"q": "Secret Metadata Name"},
        {"q": "Alias 100%_Missing"},
        {"q": "flavor_name"},
    ):
        assert client.get("/api/v1/catalog/search", params=params).json()["items"] == []


def test_collection_alias_search_preserves_copies_and_owner_isolation(named_cards):
    client, other, cards = named_cards
    commit(
        client,
        preview(
            client,
            [
                {"Scryfall ID": str(cards[0].id), "Quantity": "2", "Finish": "nonfoil"},
                {"Scryfall ID": str(cards[4].id), "Quantity": "3", "Finish": "nonfoil"},
            ],
        ),
    )
    for endpoint in ("/api/v1/collection", "/api/v1/collection/cards"):
        for query, index, copies in (("Frozen Esper #47", 0, 2), ('Sleeping "Hero"', 4, 3)):
            result = client.get(endpoint, params={"q": query}).json()
            assert result["copies"] == copies
            assert {item["printing"]["id"] for item in result["items"]} == {str(cards[index].id)}
            assert other.get(endpoint, params={"q": query}).json()["copies"] == 0


def test_collection_and_deck_imports_accept_aliases_but_reject_conflicts(named_cards):
    _, _, cards = named_cards
    with session_factory()() as db:
        for alias, index in (
            ("Search for the Frozen Esper", 0),
            ("Éclair", 3),
            ('Sleeping "Hero"', 4),
        ):
            card = cards[index]
            for identifier in ("", str(card.id)):
                values = {
                    "scryfall_id": identifier,
                    "name": alias,
                    "set_code": card.set_code,
                    "collector_number": card.collector_number,
                    "language": card.language,
                    "finish": "nonfoil",
                }
                found, error = resolve(db, values)
                assert error is None
                assert found.id == card.id and values["name"] == card.name
            values = {
                "scryfall_id": str(card.id),
                "name": "Unrelated name",
                "set_code": "",
                "collector_number": "",
                "language": "",
                "finish": "nonfoil",
            }
            assert resolve(db, values)[0] is None
        wrong_printing = {
            "scryfall_id": str(cards[1].id),
            "name": "Search for the Frozen Esper",
            "set_code": "",
            "collector_number": "",
            "language": "",
            "finish": "nonfoil",
        }
        assert resolve(db, wrong_printing)[0] is None
        result = preview_list(
            db, '1 Search for the Frozen Esper (FCA) 47\n1 Éclair\n1 Sleeping "Hero"', "text"
        )
        assert result["unresolved"] == 0
        assert [item["printing"]["id"] for item in result["items"]] == [
            str(cards[i].id) for i in (0, 3, 4)
        ]


def test_scanner_indexes_aliases_and_identifies_the_reported_title(named_cards, monkeypatch):
    _, _, cards = named_cards
    monkeypatch.setattr(recognition, "_catalog", None)
    monkeypatch.setattr(recognition, "_catalog_at", 0)
    index = recognition.catalog_index()
    for name, position in (
        ("Search for the Frozen Esper", 0),
        ("Éclair", 3),
        ('Sleeping "Hero"', 4),
    ):
        assert [row["id"] for row in index[recognition.normalized(name)]] == [cards[position].id]
    assert "secretmetadataname" not in index
    output = io.BytesIO()
    Image.new("RGB", (600, 840), "white").save(output, "PNG")
    # The original failed scan had a readable title and FCA / 0047 footer.
    monkeypatch.setattr(
        recognition,
        "read_text",
        lambda image, box, *args, **kwargs: (
            "U 0047 FCA EN" if box[1] == 758 else "Search for the Frozen Esper G"
        ),
    )
    monkeypatch.setattr(recognition, "visual_features", lambda data: None)
    monkeypatch.setattr(recognition, "load_image", lambda *args, **kwargs: (b"", None, None))
    monkeypatch.setattr(recognition, "visual_agreement", lambda *args: 0)
    result = recognition.recognize(output.getvalue())
    assert result["status"] == "MATCHED"
    assert result["candidates"][0]["printing_id"] == str(cards[0].id)
    assert result["candidates"][0]["identifiers_agree"]
    assert result["candidates"][0]["name_score"] == 1
