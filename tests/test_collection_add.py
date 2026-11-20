"""Adding copies picked from the catalog, without a photo or an import file."""

import uuid

from sqlalchemy import select
from test_collection_qol import location
from test_collections import catalog as catalog
from test_collections import key

from scanner.db import session_factory
from scanner.models import InventoryEvent, InventoryLot

PATH = "/api/v1/collection/add"


def test_added_copies_join_the_collection_once_per_request(clients, catalog):
    client, owner = clients()
    binder = location(client, "Binder A")
    body = {"printing_id": catalog[0], "binder_id": binder, "quantity": 3, "finish": "foil"}
    receipt = key()
    response = client.post(PATH, headers=receipt, json=body)
    assert response.status_code == 201, response.text
    added = response.json()
    assert added["quantity"] == 3 and added["finish"] == "foil"
    # A repeated request (a retry on a weak connection) must not add the copies again.
    assert client.post(PATH, headers=receipt, json=body).json() == added
    assert client.post(PATH, headers=receipt, json={**body, "quantity": 2}).status_code == 409
    lots = client.get("/api/v1/collection").json()["items"]
    assert [(lot["id"], lot["quantity"], lot["finish"]) for lot in lots] == [
        (added["id"], 3, "foil")
    ]
    with session_factory()() as db:
        lot = db.get(InventoryLot, uuid.UUID(added["id"]))
        assert lot.owner_id == owner and lot.condition == "ungraded"
        assert lot.source_import_row_id is None and lot.source_observation_id is None
        event = db.scalar(select(InventoryEvent).where(InventoryEvent.lot_id == lot.id))
        assert event.kind == "ADD_MANUAL" and event.delta == 3
    # The same key from another account is a different request.
    other, _ = clients()
    assert other.post(PATH, headers=receipt, json=body).status_code == 404


def test_added_copies_can_be_edited_moved_and_removed(clients, catalog):
    client, _ = clients()
    first, second = location(client, "Binder A"), location(client, "Deck box")
    added = client.post(
        PATH,
        headers=key(),
        json={
            "printing_id": catalog[1],
            "binder_id": first,
            "quantity": 4,
            "finish": "nonfoil",
            "condition": "LP",
            "notes": "From the local shop",
        },
    ).json()
    moved = client.post(
        f"/api/v1/collection/{added['id']}/move",
        headers=key(),
        json={"binder_id": second, "expected_version": added["version"], "quantity": 1},
    )
    assert moved.status_code == 200, moved.text
    removed = client.post(
        f"/api/v1/collection/{added['id']}/quantity",
        headers=key(),
        json={"expected_version": moved.json()["version"], "quantity": 0},
    )
    assert removed.status_code == 200, removed.text
    lots = client.get("/api/v1/collection").json()["items"]
    assert [(lot["quantity"], lot["condition"], lot["notes"]) for lot in lots] == [
        (1, "LP", "From the local shop")
    ]


def test_add_refuses_unknown_cards_finishes_locations_and_amounts(clients, catalog):
    client, _ = clients()
    stranger, _ = clients()
    binder = location(client, "Binder A")
    body = {"printing_id": catalog[0], "binder_id": binder, "quantity": 1, "finish": "nonfoil"}

    def status(**change):
        return client.post(PATH, headers=key(), json={**body, **change}).status_code

    assert status(printing_id=str(uuid.uuid4())) == 404
    assert status(binder_id=location(stranger, "Not yours")) == 404
    assert status(quantity=0) == 422 and status(quantity=1000) == 422
    assert status(finish="glossy") == 422
    assert client.get("/api/v1/collection").json()["items"] == []


def test_what_was_paid_is_saved_shown_with_todays_price_and_can_be_cleared(clients, catalog):
    from scanner.models import CardPrice

    client, _ = clients()
    binder = location(client, "Binder A")
    printing = uuid.UUID(catalog[0])
    with session_factory()() as db, db.begin():
        db.add(CardPrice(printing_id=printing, provider="tcgplayer", finish="foil", amount=5))
    try:
        body = {
            "printing_id": catalog[0],
            "binder_id": binder,
            "quantity": 2,
            "finish": "foil",
            "purchase_price": "3.25",
        }
        assert client.post(PATH, headers=key(), json=body).status_code == 201
        assert (
            client.post(PATH, headers=key(), json={**body, "purchase_price": "-1"}).status_code
            == 422
        )

        def lot():
            return client.get("/api/v1/collection").json()["items"][0]

        first = lot()
        assert (first["purchase_price"], first["market_price"]) == ("3.25", "5.00")
        path = f"/api/v1/collection/{first['id']}/details"
        edit = {"printing_id": catalog[0], "finish": "foil", "expected_version": first["version"]}
        # Leaving the price out keeps it.
        kept = client.post(path, headers=key(), json={**edit, "condition": "NM"})
        assert kept.status_code == 200 and lot()["purchase_price"] == "3.25"
        edit["expected_version"] = kept.json()["version"]
        changed = client.post(path, headers=key(), json={**edit, "purchase_price": "4.5"})
        assert changed.json()["purchase_price"] == "4.50"
        edit["expected_version"] = changed.json()["version"]
        receipt = key()
        cleared = client.post(path, headers=receipt, json={**edit, "purchase_price": None})
        assert cleared.status_code == 200 and cleared.json()["purchase_price"] is None
        # The same key without the price is a different request.
        assert client.post(path, headers=receipt, json=edit).status_code == 409
        final = lot()
        assert final["purchase_price"] is None and final["market_price"] is None
    finally:
        with session_factory()() as db, db.begin():
            db.query(CardPrice).filter(CardPrice.printing_id == printing).delete()
