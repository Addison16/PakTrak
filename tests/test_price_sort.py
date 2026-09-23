"""Price ordering covers the full collection, owned finishes, and missing quotes."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import delete

from scanner.db import session_factory
from scanner.models import Binder, CardPrice, CatalogSnapshot, InventoryLot, Printing


@pytest.fixture
def priced_collection(clients):
    client, owner_id = clients()
    ids = [uuid.uuid4() for _ in range(45)]
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic price ordering fixture", checksum=uuid.uuid4().hex, printings=len(ids)
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        binder = Binder(owner_id=owner_id, name="Price sort fixture", kind="binder")
        db.add(binder)
        db.flush()
        for index, identifier in enumerate(ids):
            db.add(
                Printing(
                    id=identifier,
                    name=f"Fixture {44 - index:02d}",
                    set_code="srt",
                    collector_number=str(index),
                    language="en",
                    finishes=["nonfoil", "foil"],
                    snapshot_id=snapshot.id,
                    source_json={},
                )
            )
        db.flush()
        for index, identifier in enumerate(ids):
            db.add(
                InventoryLot(
                    owner_id=owner_id,
                    binder_id=binder.id,
                    printing_id=identifier,
                    quantity_remaining=2 if index == 0 else 1,
                    finish="nonfoil",
                )
            )
            if index < 43:
                # A tie exercises stable name/printing ordering.
                amount = Decimal(index + 1 if index != 1 else 1)
                db.add(
                    CardPrice(
                        printing_id=identifier,
                        provider="tcgplayer",
                        finish="nonfoil",
                        amount=amount,
                    )
                )
                db.add(
                    CardPrice(
                        printing_id=identifier,
                        provider="manapool",
                        finish="nonfoil",
                        amount=Decimal(100) - amount,
                    )
                )
                # A quote for a finish the user does not own cannot affect ordering.
                db.add(
                    CardPrice(
                        printing_id=identifier,
                        provider="tcgplayer",
                        finish="foil",
                        amount=Decimal(1000 + index),
                    )
                )
        # This printing really has a price range, so ascending uses its low end,
        # descending its high end; quantity must not influence per-copy ordering.
        db.add(
            InventoryLot(
                owner_id=owner_id,
                binder_id=binder.id,
                printing_id=ids[0],
                quantity_remaining=1,
                finish="foil",
            )
        )
    yield client, [str(identifier) for identifier in ids]
    with session_factory()() as db, db.begin():
        db.execute(delete(InventoryLot).where(InventoryLot.printing_id.in_(ids)))
        db.execute(delete(Printing).where(Printing.id.in_(ids)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def all_cards(client, **params):
    result = []
    offset = 0
    while True:
        response = client.get("/api/v1/collection/cards", params={**params, "offset": offset})
        assert response.status_code == 200, response.text
        page = response.json()
        result.extend(page["items"])
        if page["next_offset"] is None:
            return result
        assert page["next_offset"] > offset
        offset = page["next_offset"]


@pytest.mark.parametrize(
    "sort,field,reverse", [("price_asc", "price_min", False), ("price_desc", "price_max", True)]
)
def test_price_sort_is_global_stable_and_unpriced_last(priced_collection, sort, field, reverse):
    client, ids = priced_collection
    cards = all_cards(client, sort=sort)
    assert len(cards) == len({card["printing"]["id"] for card in cards}) == 45
    prices = [Decimal(card[field]) for card in cards if card[field] is not None]
    assert prices == sorted(prices, reverse=reverse)
    assert all(card[field] is None for card in cards[-2:])
    assert [card["printing"]["id"] for card in cards] == [
        card["printing"]["id"] for card in all_cards(client, sort=sort)
    ]
    if reverse:
        assert cards[0]["printing"]["id"] == ids[0]
        assert cards == all_cards(client, sort="price")  # Existing API clients keep their ordering.
    else:
        assert cards[0]["printing"]["id"] == ids[1]  # Tied prices resolve by name.
        assert cards[1]["printing"]["id"] == ids[0]


def test_price_sort_tracks_source_filters_and_ownership(priced_collection, clients):
    client, ids = priced_collection
    pool = all_cards(client, provider="manapool", sort="price_asc")
    assert pool[0]["printing"]["id"] == ids[42]
    assert pool[-1]["price_min"] is None
    filtered = all_cards(client, sort="price_desc", min_price="10", max_price="15")
    assert [Decimal(card["price_max"]) for card in filtered] == list(map(Decimal, range(15, 9, -1)))
    # Excluding the owned foil price changes the high-to-low leader.
    normal = all_cards(client, sort="price_desc", finish="nonfoil")
    assert normal[0]["printing"]["id"] == ids[42]
    other, _ = clients()
    assert all_cards(other, sort="price_asc") == []
    assert (
        client.get("/api/v1/collection/cards", params={"sort": "bad-direction"}).status_code == 422
    )
