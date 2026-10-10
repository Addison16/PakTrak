import uuid

from sqlalchemy import delete

from scanner.db import session_factory
from scanner.foil_types import special_foil
from scanner.models import Binder, CatalogSnapshot, InventoryLot, Printing


def test_special_foil_reads_scryfall_promo_types():
    assert special_foil({}) is None
    assert special_foil({"promo_types": ["boosterfun"]}) is None
    assert special_foil({"promo_types": ["boosterfun", "galaxyfoil"]}) == "galaxy"
    assert special_foil({"promo_types": ["neoninkyellow"]}) == "neon_ink"
    # The more specific treatment wins when a printing lists two.
    assert special_foil({"promo_types": ["textured", "surgefoil"]}) == "surge"


def test_collection_filters_by_foil_type(clients):
    client, owner_id = clients()
    other, other_id = clients()
    snapshot_id, plain_id, galaxy_id, fracture_id = (uuid.uuid4() for _ in range(4))
    binder_id, other_binder_id = uuid.uuid4(), uuid.uuid4()
    printings = (
        (plain_id, "1", ["nonfoil", "foil", "etched"], {}),
        (galaxy_id, "2", ["foil"], {"promo_types": ["boosterfun", "galaxyfoil"]}),
        (fracture_id, "3", ["nonfoil", "foil"], {"promo_types": ["fracturefoil"]}),
    )
    with session_factory()() as db, db.begin():
        db.add(
            CatalogSnapshot(
                id=snapshot_id, source="foil types", checksum=str(snapshot_id), printings=3
            )
        )
        db.flush()
        for printing_id, number, finishes, raw in printings:
            db.add(
                Printing(
                    id=printing_id,
                    name="Foil type fixture " + number,
                    set_code="tst",
                    collector_number=number,
                    language="en",
                    finishes=finishes,
                    snapshot_id=snapshot_id,
                    source_json=raw,
                )
            )
        db.add(Binder(id=binder_id, owner_id=owner_id, name="Foils"))
        db.add(Binder(id=other_binder_id, owner_id=other_id, name="Other"))
        db.flush()
        for owner, binder, printing, finish in (
            (owner_id, binder_id, plain_id, "foil"),
            (owner_id, binder_id, plain_id, "etched"),
            (owner_id, binder_id, plain_id, "nonfoil"),
            (owner_id, binder_id, galaxy_id, "foil"),
            (owner_id, binder_id, fracture_id, "nonfoil"),
            (other_id, other_binder_id, fracture_id, "foil"),
        ):
            db.add(
                InventoryLot(
                    owner_id=owner,
                    binder_id=binder,
                    printing_id=printing,
                    finish=finish,
                    quantity_remaining=1,
                )
            )
    try:

        def cards(user=client, **params):
            response = user.get("/api/v1/collection/cards", params=params)
            assert response.status_code == 200, response.text
            return {item["printing"]["id"]: item for item in response.json()["items"]}

        everything = cards()
        assert everything[str(galaxy_id)]["printing"]["foil_type"] == "galaxy"
        assert everything[str(fracture_id)]["printing"]["foil_type"] == "fracture"
        assert "foil_type" not in everything[str(plain_id)]["printing"]

        assert set(cards(foil_type="any")) == {str(plain_id), str(galaxy_id)}
        assert cards(foil_type="any")[str(plain_id)]["quantity"] == 2
        assert set(cards(foil_type="regular")) == {str(plain_id)}
        assert cards(foil_type="regular")[str(plain_id)]["finish_counts"]["foil"] == 1
        assert cards(foil_type="regular")[str(plain_id)]["finish_counts"]["etched"] == 0
        assert set(cards(foil_type="etched")) == {str(plain_id)}
        assert set(cards(foil_type="galaxy")) == {str(galaxy_id)}
        # A nonfoil copy of a fracture foil printing is not a fracture foil.
        assert cards(foil_type="fracture") == {}
        assert set(cards(other, foil_type="fracture")) == {str(fracture_id)}
        bad = client.get("/api/v1/collection/cards", params={"foil_type": "shiny"})
        assert bad.status_code == 422

        assert client.get("/api/v1/collection/filters").json()["foil_types"] == [
            "regular",
            "etched",
            "galaxy",
        ]
        assert other.get("/api/v1/collection/filters").json()["foil_types"] == ["fracture"]
    finally:
        with session_factory()() as db, db.begin():
            db.execute(
                delete(InventoryLot).where(
                    InventoryLot.printing_id.in_((plain_id, galaxy_id, fracture_id))
                )
            )
            db.execute(delete(Printing).where(Printing.id.in_((plain_id, galaxy_id, fracture_id))))
            db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))
