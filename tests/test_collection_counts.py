import uuid

from sqlalchemy import delete
from test_collections import catalog as catalog
from test_collections import commit, export, key, preview, run_batch

from scanner.db import session_factory
from scanner.models import Binder, InventoryLot, Printing, User


def test_duplicate_counts_preserve_locations_variants_and_source_specific_undo(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    first = commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "2",
                    "Location": "Red binder",
                    "Finish": "nonfoil",
                    "Condition": "NM",
                    "Notes": "First copies",
                },
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "3",
                    "Location": "Red binder",
                    "Finish": "nonfoil",
                    "Condition": "NM",
                    "Notes": "More copies",
                },
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "1",
                    "Location": "Box 4",
                    "Finish": "foil",
                    "Condition": "LP",
                    "Notes": "Foil copy",
                },
                {
                    "Scryfall ID": catalog[1],
                    "Quantity": "4",
                    "Location": "Red binder",
                    "Finish": "nonfoil",
                    "Condition": "NM",
                    "Notes": "Different printing",
                },
            ],
        ),
    )
    second = commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "2",
                    "Location": "Red binder",
                    "Notes": "Second import",
                }
            ],
        ),
    )
    commit(other, preview(other, [{"Scryfall ID": catalog[0], "Quantity": "99"}]))
    run_batch(client, first, "IMPORT_COMMIT")  # A repeated worker adds no copies.
    result = client.get("/api/v1/collection/cards").json()
    assert (result["copies"], result["cards"], result["next_offset"]) == (12, 2, None)
    cards = {card["printing"]["id"]: card for card in result["items"]}
    assert cards[catalog[0]]["quantity"] == 8
    assert cards[catalog[1]]["quantity"] == 4  # Same name, different printing.
    locations = {item["name"]: item for item in cards[catalog[0]]["locations"]}
    assert {name: item["quantity"] for name, item in locations.items()} == {
        "Red binder": 7,
        "Box 4": 1,
    }
    assert cards[catalog[0]]["location_count"] == 2
    red = {"binder_id": locations["Red binder"]["id"]}
    filtered = client.get("/api/v1/collection/cards", params={**red, "q": "fixture"}).json()
    assert (filtered["copies"], filtered["cards"]) == (11, 2)
    assert other.get("/api/v1/collection/cards", params=red).status_code == 404
    assert (
        other.get("/api/v1/collection", params={**red, "printing_id": catalog[0]}).status_code
        == 404
    )
    for query in ("%", "_", "not owned"):
        assert client.get("/api/v1/collection/cards", params={"q": query}).json()["copies"] == 0

    lots = client.get("/api/v1/collection", params={"printing_id": catalog[0]}).json()
    assert lots["copies"] == 8 and len(lots["items"]) == 4
    assert all(item["printing"]["id"] == catalog[0] for item in lots["items"])
    foil = next(item for item in lots["items"] if item["finish"] == "foil")
    assert (foil["quantity"], foil["condition"], foil["notes"]) == (1, "LP", "Foil copy")
    source = next(item for item in lots["items"] if item["notes"] == "First copies")
    assert (
        client.post(
            f"/api/v1/collection/{source['id']}/quantity",
            headers=key(),
            json={"quantity": 1, "expected_version": source["version"]},
        ).status_code
        == 200
    )
    assert client.get("/api/v1/collection/cards").json()["copies"] == 11

    undo = client.post(
        f"/api/v1/imports/{second['id']}/undo",
        headers=key(),
        json={"expected_revision": second["revision"]},
    )
    assert undo.status_code == 202
    run_batch(client, undo.json(), "IMPORT_UNDO")
    cards = {
        card["printing"]["id"]: card
        for card in client.get("/api/v1/collection/cards").json()["items"]
    }
    assert cards[catalog[0]]["quantity"] == 5
    assert cards[catalog[1]]["quantity"] == 4
    assert (
        client.post(
            f"/api/v1/collection/{foil['id']}/move",
            headers=key(),
            json={"binder_id": red["binder_id"], "expected_version": foil["version"]},
        ).status_code
        == 200
    )
    moved = client.get("/api/v1/collection/cards").json()["items"][0]
    assert moved["quantity"] == 5 and moved["location_count"] == 1
    assert moved["locations"][0]["quantity"] == 5
    assert export(client)["report"]["copies"] == 9
    assert other.get("/api/v1/collection/cards").json()["copies"] == 99


def test_duplicate_counts_group_before_pagination_and_bound_location_previews(clients, catalog):
    client, owner_id = clients()
    ids = [uuid.uuid4() for _ in range(42)]
    try:
        with session_factory()() as db, db.begin():
            snapshot_id = db.get(Printing, uuid.UUID(catalog[0])).snapshot_id
            binders = [Binder(owner_id=owner_id, name=f"Box {i}", kind="box") for i in range(6)]
            db.add_all(binders)
            for i, printing_id in enumerate(ids):
                db.add(
                    Printing(
                        id=printing_id,
                        name=f"Grouped fixture {i:02}",
                        set_code="tst",
                        collector_number=str(i),
                        language="en",
                        finishes=["nonfoil"],
                        snapshot_id=snapshot_id,
                        source_json={},
                    )
                )
            db.flush()
            # Seed the read-model stress case independently of the API. Import
            # and observation accounting are exercised through their real flows.
            for printing_id in ids + [ids[0]] * 80:
                index = 0 if printing_id != ids[0] else len(db.new) % 6
                db.add(
                    InventoryLot(
                        owner_id=owner_id,
                        printing_id=printing_id,
                        binder_id=binders[index].id,
                        quantity_remaining=1,
                    )
                )
        first = client.get("/api/v1/collection/cards").json()
        assert (first["copies"], first["cards"], first["next_offset"]) == (122, 42, 40)
        assert len(first["items"]) == 40
        assert first["items"][0]["quantity"] == 81
        assert first["items"][0]["location_count"] == 6
        assert len(first["items"][0]["locations"]) == 3
        second = client.get("/api/v1/collection/cards?offset=40").json()
        assert (second["copies"], second["cards"], second["next_offset"]) == (122, 42, None)
        assert len(second["items"]) == 2
        assert len({card["printing"]["id"] for card in first["items"] + second["items"]}) == 42
        assert sum(card["quantity"] for card in first["items"] + second["items"]) == 122
        end = client.get("/api/v1/collection/cards?offset=99").json()
        assert {key: end[key] for key in ("copies", "cards", "items", "next_offset")} == {
            "copies": 122,
            "cards": 42,
            "items": [],
            "next_offset": None,
        }
        copies = []
        for offset in (0, 40, 80):
            page = client.get(
                "/api/v1/collection", params={"printing_id": str(ids[0]), "offset": offset}
            ).json()
            assert page["copies"] == 81
            copies += page["items"]
        assert sum(lot["quantity"] for lot in copies) == 81
        assert len({lot["binder_id"] for lot in copies}) == 6
    finally:
        with session_factory()() as db, db.begin():
            db.execute(delete(User).where(User.id == owner_id))
            db.execute(delete(Printing).where(Printing.id.in_(ids)))


def test_empty_or_removed_collection_has_zero_card_counts(clients, catalog):
    client, _ = clients()
    empty = {
        "copies": 0,
        "cards": 0,
        "items": [],
        "next_offset": None,
        "valuation": {
            "provider": "tcgplayer",
            "amount": None,
            "priced_copies": 0,
            "unpriced_copies": 0,
            "pricing_issues": {"unknown_finish": 0, "custom_value": 0, "missing_price": 0},
            "feed": None,
        },
    }
    assert client.get("/api/v1/collection/cards").json() == empty
    assert client.get("/api/v1/collection/cards?offset=40").json() == empty
    commit(client, preview(client, [{"Scryfall ID": catalog[0], "Quantity": "2"}]))
    lot = client.get("/api/v1/collection").json()["items"][0]
    assert (
        client.post(
            f"/api/v1/collection/{lot['id']}/quantity",
            headers=key(),
            json={"quantity": 0, "expected_version": lot["version"]},
        ).status_code
        == 200
    )
    assert client.get("/api/v1/collection/cards").json() == empty
