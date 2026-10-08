import secrets
import uuid

import pytest
from sqlalchemy import delete
from test_collections import commit, preview

from scanner.card_search import split_collector_search
from scanner.db import session_factory
from scanner.models import CatalogSnapshot, Printing, User


@pytest.mark.parametrize(
    "query, expected",
    [
        (" Plains #287 ", ("Plains", "287")),
        ("Lightning Bolt# 150a", ("Lightning Bolt", "150a")),
        ("Plains #287★", ("Plains", "287★")),
        ("Plains #0287", ("Plains", "0287")),
        ("#287", ("", "287")),
        ("Fire // Ice #123", ("Fire // Ice", "123")),
        ("Plains #", ("Plains #", "")),
        ("Garruk's #1 Fan", ("Garruk's #1 Fan", "")),
        (" Plains ", ("Plains", "")),
        ("Plains #" + "1" * 33, ("Plains #" + "1" * 33, "")),
    ],
)
def test_collector_shortcut_keeps_suffixes_and_literal_non_shortcut_text(query, expected):
    assert split_collector_search(query) == expected


@pytest.fixture
def numbered_cards(clients):
    client, owner = clients()
    other, other_owner = clients()
    cards = []
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="collector search fixture", checksum=secrets.token_hex(32), printings=31
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        rows = (
            [("Plains", f"p{i:02}", "287", "en") for i in range(22)]
            + [
                ("Plains", "alt", number, "en")
                for number in ("1287", "2870", "287a", "287★", "288")
            ]
            + [
                ("Plains", "p00", "287", "fr"),
                ("Island", "alt", "287", "en"),
                ("Lightning Bolt", "alt", "287", "en"),
                ("Lightning Bolt", "alt", "0287", "en"),
            ]
        )
        for name, edition, number, language in rows:
            card = Printing(
                id=uuid.uuid4(),
                name=name,
                set_code=edition,
                collector_number=number,
                language=language,
                finishes=["nonfoil", "foil"],
                snapshot_id=snapshot_id,
                source_json={
                    "set_name": f"Search {edition.upper()}",
                    "rarity": "common",
                    "type_line": "Instant" if name == "Lightning Bolt" else "Basic Land",
                    "oracle_text": "Search fixture rules text.",
                },
            )
            db.add(card)
            cards.append(card)
        ids = [card.id for card in cards]
    yield client, other, cards
    with session_factory()() as db, db.begin():
        db.execute(delete(User).where(User.id.in_([owner, other_owner])))
        db.execute(delete(Printing).where(Printing.id.in_(ids)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def test_catalog_shortcut_exact_numbers_pagination_and_matching_set_options(numbered_cards):
    client, _, cards = numbered_cards
    params = {"q": " Plains # 287 ", "exact_name": True, "facets": True, "language": "en"}
    first = client.get("/api/v1/catalog/search", params=params)
    assert first.status_code == 200, first.text
    data = first.json()
    assert len(data["items"]) == 20 and data["next_offset"] == 20
    second = client.get("/api/v1/catalog/search", params={**params, "offset": 20}).json()
    assert second["next_offset"] is None
    assert {item["id"] for item in data["items"] + second["items"]} == {
        str(card.id) for card in cards[:22]
    }
    assert {item["code"] for item in data["filters"]["sets"]} == {f"p{i:02}" for i in range(22)}
    assert data["filters"]["languages"] == ["en", "fr"]
    selected = client.get(
        "/api/v1/catalog/search", params={**params, "set_code": "P03", "rarity": "common"}
    ).json()
    assert [item["id"] for item in selected["items"]] == [str(cards[3].id)]
    # An incompatible second filter must never silently broaden the requested printing.
    assert (
        client.get("/api/v1/catalog/search", params={**params, "collector_number": "288"}).json()[
            "items"
        ]
        == []
    )


def test_catalog_shortcut_handles_nonlands_suffixes_ids_and_no_matches(numbered_cards):
    client, _, cards = numbered_cards
    for query, name, number in [
        ("lightning bolt #287", "Lightning Bolt", "287"),
        ("Lightning Bolt #0287", "Lightning Bolt", "0287"),
        ("Plains#287A", "Plains", "287a"),
        ("Plains #287★", "Plains", "287★"),
    ]:
        result = client.get("/api/v1/catalog/search", params={"q": query}).json()
        assert len(result["items"]) == 1
        assert (result["items"][0]["name"], result["items"][0]["collector_number"]) == (
            name,
            number,
        )
    for query in ("Plains #999999", "Plains #287%", "%_ #287", "Plains #"):
        assert client.get("/api/v1/catalog/search", params={"q": query}).json()["items"] == []
    by_number = client.get("/api/v1/catalog/search", params={"q": "#287", "set_code": "alt"}).json()
    assert {item["name"] for item in by_number["items"]} == {"Island", "Lightning Bolt"}
    by_id = client.get("/api/v1/catalog/search", params={"q": str(cards[0].id)}).json()
    assert [item["id"] for item in by_id["items"]] == [str(cards[0].id)]


def test_owned_search_shortcut_filters_copies_without_exposing_other_collections(numbered_cards):
    client, other, cards = numbered_cards
    chosen = [cards[0], cards[1], cards[-5], cards[-2], cards[-1]]
    commit(
        client,
        preview(
            client,
            [
                {"Scryfall ID": str(card.id), "Quantity": str(index + 1), "Finish": "nonfoil"}
                for index, card in enumerate(chosen)
            ],
        ),
    )
    for endpoint in ("/api/v1/collection", "/api/v1/collection/cards"):
        for query, expected_ids, copies in [
            ("Plains #287", {str(cards[0].id), str(cards[1].id)}, 3),
            ("Plains #288", {str(cards[-5].id)}, 3),
            ("Lightning Bolt#287", {str(cards[-2].id)}, 4),
            ("#0287", {str(cards[-1].id)}, 5),
            ("Plains #999999", set(), 0),
            ("%_ #287", set(), 0),
        ]:
            response = client.get(endpoint, params={"q": query})
            assert response.status_code == 200, response.text
            result = response.json()
            assert {item["printing"]["id"] for item in result["items"]} == expected_ids
            assert result["copies"] == copies
        assert other.get(endpoint, params={"q": "#287"}).json()["copies"] == 0
    filtered = client.get(
        "/api/v1/collection/cards", params={"q": "Plains #287", "set_code": "p01"}
    ).json()
    assert filtered["copies"] == 2
    rules = client.get("/api/v1/collection/cards", params={"q": "fixture rules #0287"}).json()
    assert rules["copies"] == 5
