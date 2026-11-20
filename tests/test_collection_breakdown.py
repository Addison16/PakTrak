"""Collection breakdown: copies and value by color, rarity, type, set and location."""

import secrets
import uuid

import pytest
from sqlalchemy import delete
from test_collection_qol import location
from test_collections import key

from scanner.db import session_factory
from scanner.models import CardPrice, CatalogSnapshot, InventoryLot, Printing

CARDS = [
    ("Red Dragon", "aaa", "Alpha set", ["R"], "mythic", "Creature — Dragon", 10),
    ("Gold Charm", "aaa", "Alpha set", ["W", "U"], "rare", "Instant", 2),
    ("Plain Field", "bbb", "Beta set", [], "common", "Basic Land — Plains", None),
    ("Iron Golem", "bbb", "Beta set", [], "uncommon", "Artifact Creature — Golem", 1),
]


@pytest.fixture
def cards(isolated_database):
    ids = [uuid.uuid4() for _ in CARDS]
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic breakdown fixture", checksum=secrets.token_hex(32), printings=4
        )
        db.add(snapshot)
        db.flush()
        for identifier, (name, code, set_name, colors, rarity, type_line, price) in zip(
            ids, CARDS, strict=True
        ):
            db.add(
                Printing(
                    id=identifier,
                    name=name,
                    set_code=code,
                    collector_number="1",
                    language="en",
                    finishes=["nonfoil", "foil"],
                    snapshot_id=snapshot.id,
                    source_json={
                        "set_name": set_name,
                        "color_identity": colors,
                        "rarity": rarity,
                        "type_line": type_line,
                    },
                )
            )
            if price:
                db.flush()
                db.add(
                    CardPrice(
                        printing_id=identifier, provider="tcgplayer", finish="nonfoil", amount=price
                    )
                )
        snapshot_id = snapshot.id
    yield [str(value) for value in ids]
    with session_factory()() as db, db.begin():
        db.execute(delete(InventoryLot).where(InventoryLot.printing_id.in_(ids)))
        db.execute(delete(CardPrice).where(CardPrice.printing_id.in_(ids)))
        db.execute(delete(Printing).where(Printing.id.in_(ids)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def test_breakdown_groups_copies_and_value_and_compares_what_was_paid(clients, cards):
    client, _ = clients()
    stranger, _ = clients()
    binder, box = location(client, "Binder A"), location(client, "Bulk box")

    def add(who, card, where, quantity, **extra):
        body = {"printing_id": card, "binder_id": where, "quantity": quantity, "finish": "nonfoil"}
        response = who.post("/api/v1/collection/add", headers=key(), json={**body, **extra})
        assert response.status_code == 201, response.text

    add(client, cards[0], binder, 1, purchase_price="4.00")
    add(client, cards[1], binder, 2)
    add(client, cards[2], box, 20, purchase_price="0.10")
    add(client, cards[3], box, 3)
    add(stranger, cards[0], location(stranger, "Theirs"), 5)

    data = client.get("/api/v1/collection/breakdown").json()
    assert (data["copies"], data["value"], data["provider"]) == (26, "17.00", "tcgplayer")

    def rows(name):
        return [(row["label"], row["copies"], row["value"]) for row in data[name]]

    assert rows("colors") == [
        ("Red", 1, "10.00"),
        ("Multicolor", 2, "4.00"),
        ("Colorless", 23, "3.00"),
    ]
    assert rows("rarities") == [
        ("Mythic", 1, "10.00"),
        ("Rare", 2, "4.00"),
        ("Uncommon", 3, "3.00"),
        ("Common", 20, None),
    ]
    assert rows("types") == [
        ("Land", 20, None),
        ("Creature", 4, "13.00"),
        ("Instant", 2, "4.00"),
    ]
    assert rows("sets") == [("Alpha set", 3, "14.00"), ("Beta set", 23, "3.00")]
    assert rows("locations") == [("Binder A", 3, "14.00"), ("Bulk box", 23, "3.00")]
    assert [(card["printing"]["name"], card["amount"]) for card in data["top_cards"]] == [
        ("Red Dragon", "10.00"),
        ("Gold Charm", "2.00"),
        ("Iron Golem", "1.00"),
    ]
    # The lands have no price today, so only the dragon can be compared.
    assert data["paid"] == {
        "copies": 1,
        "unpriced_copies": 20,
        "paid": "4.00",
        "value": "10.00",
        "change": "6.00",
    }
    empty, _ = clients()
    blank = empty.get("/api/v1/collection/breakdown").json()
    assert blank["copies"] == 0 and blank["paid"] is None and blank["top_cards"] == []
