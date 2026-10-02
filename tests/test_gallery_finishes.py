import uuid
from decimal import Decimal

from sqlalchemy import delete

from scanner.db import session_factory
from scanner.models import Binder, CardPrice, CatalogSnapshot, InventoryLot, Printing


def test_owned_finish_counts_follow_collection_filters_and_never_catalog_availability(clients):
    client, owner_id = clients()
    other, other_id = clients()
    snapshot_id, card_id, normal_id = (uuid.uuid4() for _ in range(3))
    red_id, blue_id, other_binder_id = (uuid.uuid4() for _ in range(3))
    with session_factory()() as db, db.begin():
        db.add(
            CatalogSnapshot(
                id=snapshot_id,
                source="owned finish fixture",
                checksum=str(snapshot_id),
                printings=2,
            )
        )
        db.flush()
        for printing_id, number in ((card_id, "1"), (normal_id, "2")):
            db.add(
                Printing(
                    id=printing_id,
                    name="Finish fixture " + number,
                    set_code="tst",
                    collector_number=number,
                    language="en",
                    finishes=["nonfoil", "foil", "etched"],
                    snapshot_id=snapshot_id,
                    source_json={},
                )
            )
        for binder_id, owner, name in (
            (red_id, owner_id, "Red binder"),
            (blue_id, owner_id, "Blue binder"),
            (other_binder_id, other_id, "Other collection"),
        ):
            db.add(Binder(id=binder_id, owner_id=owner, name=name))
        db.flush()
        for owner, binder, printing, finish, quantity in (
            (owner_id, red_id, card_id, "nonfoil", 3),
            (owner_id, red_id, card_id, "foil", 2),
            (owner_id, red_id, card_id, "etched", 1),
            (owner_id, red_id, card_id, "unknown", 4),
            (owner_id, blue_id, card_id, "nonfoil", 1),
            (owner_id, blue_id, card_id, "foil", 3),
            (owner_id, blue_id, card_id, "etched", 2),
            (owner_id, red_id, card_id, "foil", 0),
            (owner_id, red_id, normal_id, "nonfoil", 8),
            (other_id, other_binder_id, card_id, "foil", 90),
        ):
            db.add(
                InventoryLot(
                    owner_id=owner,
                    binder_id=binder,
                    printing_id=printing,
                    finish=finish,
                    quantity_remaining=quantity,
                )
            )
        for finish, amount in (("nonfoil", "1"), ("foil", "5"), ("etched", "10")):
            db.add(
                CardPrice(
                    printing_id=card_id, provider="tcgplayer", finish=finish, amount=Decimal(amount)
                )
            )
    try:

        def grouped(**params):
            response = client.get("/api/v1/collection/cards", params=params)
            assert response.status_code == 200, response.text
            return {item["printing"]["id"]: item for item in response.json()["items"]}

        cards = grouped()
        assert cards[str(card_id)]["finish_counts"] == {
            "nonfoil": 4,
            "foil": 5,
            "etched": 3,
            "unknown": 4,
        }
        assert cards[str(card_id)]["quantity"] == 16
        assert cards[str(normal_id)]["finish_counts"] == {
            "nonfoil": 8,
            "foil": 0,
            "etched": 0,
            "unknown": 0,
        }
        assert grouped(binder_id=str(red_id))[str(card_id)]["finish_counts"] == {
            "nonfoil": 3,
            "foil": 2,
            "etched": 1,
            "unknown": 4,
        }
        assert grouped(finish="etched")[str(card_id)]["finish_counts"] == {
            "nonfoil": 0,
            "foil": 0,
            "etched": 3,
            "unknown": 0,
        }
        assert grouped(min_price="4", max_price="6")[str(card_id)]["finish_counts"] == {
            "nonfoil": 0,
            "foil": 5,
            "etched": 0,
            "unknown": 0,
        }
        assert grouped(binder_id=str(red_id), min_price="4", max_price="6")[str(card_id)][
            "finish_counts"
        ] == {"nonfoil": 0, "foil": 2, "etched": 0, "unknown": 0}
        detail = client.get(f"/api/v1/collection/cards/{card_id}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["finish_counts"] == cards[str(card_id)]["finish_counts"]
        other_cards = other.get("/api/v1/collection/cards").json()["items"]
        assert other_cards[0]["finish_counts"] == {
            "nonfoil": 0,
            "foil": 90,
            "etched": 0,
            "unknown": 0,
        }
    finally:
        with session_factory()() as db, db.begin():
            db.execute(
                delete(InventoryLot).where(InventoryLot.printing_id.in_((card_id, normal_id)))
            )
            db.execute(delete(Printing).where(Printing.id.in_((card_id, normal_id))))
            db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))
