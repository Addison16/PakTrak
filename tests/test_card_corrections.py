import csv
import io
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import delete, select
from test_collections import catalog as catalog
from test_collections import commit, export, key, preview, run_batch

from scanner.db import session_factory
from scanner.models import CardPrice, ImportRow, InventoryEvent, InventoryLot, Printing, User


@pytest.fixture
def corrections(clients, catalog):
    client, owner = clients()
    other, other_owner = clients()
    ids = [uuid.uuid4() for _ in range(3)]
    with session_factory()() as db, db.begin():
        snapshot = db.get(Printing, uuid.UUID(catalog[0])).snapshot_id
        for index, (code, rarity) in enumerate(
            [("ca", "common"), ("cb", "rare"), ("cc", "uncommon")]
        ):
            db.add(
                Printing(
                    id=ids[index],
                    name="Correction Fixture Card",
                    set_code=code,
                    collector_number=str(index + 1),
                    language="en",
                    finishes=["nonfoil", "foil"] if index < 2 else ["foil"],
                    snapshot_id=snapshot,
                    source_json={"set_name": f"Correction {code.upper()}", "rarity": rarity},
                )
            )
        db.flush()
        for index, price in enumerate(["1", "5"]):
            db.add(
                CardPrice(
                    printing_id=ids[index],
                    provider="tcgplayer",
                    finish="nonfoil",
                    amount=Decimal(price),
                )
            )
    yield client, other, [str(value) for value in ids]
    with session_factory()() as db, db.begin():
        db.execute(delete(User).where(User.id.in_([owner, other_owner])))
        db.execute(delete(CardPrice).where(CardPrice.printing_id.in_(ids)))
        db.execute(delete(Printing).where(Printing.id.in_(ids)))


def test_card_correction_updates_printing_rarity_prices_exports_and_preserves_undo(corrections):
    client, other, ids = corrections
    batch = commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": ids[0],
                    "Quantity": "3",
                    "Finish": "nonfoil",
                    "Location": "Red binder",
                    "Condition": "LP",
                    "Notes": "Keep this note",
                }
            ],
        ),
    )
    commit(client, preview(client, [{"Scryfall ID": ids[0], "Quantity": "2", "Finish": "nonfoil"}]))
    commit(other, preview(other, [{"Scryfall ID": ids[0], "Quantity": "4", "Finish": "nonfoil"}]))
    lot = next(
        item for item in client.get("/api/v1/collection").json()["items"] if item["quantity"] == 3
    )
    path = f"/api/v1/collection/{lot['id']}/details"
    data = {"expected_version": lot["version"], "printing_id": ids[1], "finish": "nonfoil"}
    headers = key()
    saved = client.post(path, headers=headers, json=data)
    assert saved.status_code == 200, saved.text
    assert saved.json()["printing"]["rarity"] == "rare"
    assert client.post(path, headers=headers, json=data).json() == saved.json()
    assert client.post(path, headers=headers, json={**data, "finish": "foil"}).status_code == 409
    assert client.post(path, headers=key(), json=data).status_code == 409
    current = next(
        item for item in client.get("/api/v1/collection").json()["items"] if item["id"] == lot["id"]
    )
    for field in ("quantity", "binder_id", "condition", "notes", "source_import_row_id"):
        assert current[field] == lot[field]
    summary = client.get("/api/v1/collection/cards").json()
    assert (summary["copies"], summary["cards"], Decimal(summary["valuation"]["amount"])) == (
        5,
        2,
        Decimal("17"),
    )
    assert client.get("/api/v1/collection/cards?rarity=rare&set_code=cb").json()["copies"] == 3
    assert other.get("/api/v1/collection/cards").json()["items"][0]["printing"]["id"] == ids[0]
    with session_factory()() as db:
        events = db.scalars(
            select(InventoryEvent).where(
                InventoryEvent.lot_id == uuid.UUID(lot["id"]), InventoryEvent.kind == "CORRECT_CARD"
            )
        ).all()
        assert len(events) == 1 and events[0].delta == 0
        assert events[0].detail["before"]["printing_id"] == ids[0]
        assert events[0].detail["after"]["printing_id"] == ids[1]
        # The original file remains an accurate record of what was imported.
        assert str(db.get(ImportRow, uuid.UUID(lot["source_import_row_id"])).printing_id) == ids[0]
    downloaded = export(client)
    rows = list(
        csv.DictReader(
            io.StringIO(client.get(downloaded["download_url"]).content.decode("utf-8-sig"))
        )
    )
    corrected = next(row for row in rows if row["scryfall_id"] == ids[1])
    assert corrected["quantity"] == "3" and corrected["set_code"] == "cb"
    undo = client.post(
        f"/api/v1/imports/{batch['id']}/undo",
        headers=key(),
        json={"expected_revision": batch["revision"]},
    )
    assert undo.status_code == 202
    # Even a retry must respect the undo barrier.
    assert client.post(path, headers=headers, json=data).status_code == 409
    run_batch(client, undo.json(), "IMPORT_UNDO")
    remaining = client.get("/api/v1/collection/cards").json()
    assert remaining["copies"] == 2 and remaining["items"][0]["printing"]["id"] == ids[0]


def test_card_correction_rejects_unowned_missing_removed_and_incompatible_printings(corrections):
    client, other, ids = corrections
    commit(client, preview(client, [{"Scryfall ID": ids[0], "Quantity": "1"}]))
    lot = client.get("/api/v1/collection").json()["items"][0]
    path = f"/api/v1/collection/{lot['id']}/details"
    data = {"expected_version": lot["version"], "printing_id": ids[1], "finish": "nonfoil"}
    assert other.post(path, headers=key(), json=data).status_code == 404
    assert client.post(path, headers=key(), json={**data, "rarity": "mythic"}).status_code == 422
    assert (
        client.post(
            path, headers=key(), json={**data, "printing_id": str(uuid.uuid4())}
        ).status_code
        == 404
    )
    assert client.post(path, headers=key(), json={**data, "printing_id": ids[2]}).status_code == 422
    with session_factory()() as db:
        unchanged = db.get(InventoryLot, uuid.UUID(lot["id"]))
        assert (str(unchanged.printing_id), unchanged.finish, unchanged.version) == (
            ids[0],
            "unknown",
            lot["version"],
        )
    saved = client.post(path, headers=key(), json={**data, "printing_id": ids[2], "finish": "foil"})
    assert saved.status_code == 200
    removed = client.post(
        f"/api/v1/collection/{lot['id']}/quantity",
        headers=key(),
        json={"expected_version": saved.json()["version"], "quantity": 0},
    )
    assert removed.status_code == 200
    assert (
        client.post(
            path, headers=key(), json={**data, "expected_version": removed.json()["version"]}
        ).status_code
        == 409
    )


def test_printing_search_filters_rarity_set_number_and_language_without_provider_requests(
    corrections,
):
    client, _, ids = corrections
    params = {
        "q": "Correction Fixture Card",
        "exact_name": True,
        "facets": True,
        "rarity": "rare",
        "set_code": "CB",
        "collector_number": "2",
        "language": "EN",
    }
    result = client.get("/api/v1/catalog/search", params=params).json()
    assert [card["id"] for card in result["items"]] == [ids[1]]
    assert result["filters"] == {
        "sets": [
            {"code": code, "name": f"Correction {code.upper()}"} for code in ("ca", "cb", "cc")
        ],
        "rarities": ["common", "rare", "uncommon"],
        "languages": ["en"],
    }
    for field, value in (("rarity", "common"), ("collector_number", "1"), ("language", "fr")):
        response = client.get("/api/v1/catalog/search", params={**params, field: value})
        assert response.json()["items"] == []
    assert (
        client.get("/api/v1/catalog/search", params={"q": "%_", "facets": True}).json()["items"]
        == []
    )
    assert (
        client.get(
            "/api/v1/catalog/search", params={"q": "Correction Fixture", "exact_name": True}
        ).json()["items"]
        == []
    )


def test_gallery_price_ranges_use_owned_finishes_selected_provider_and_filtered_totals(corrections):
    client, other, ids = corrections
    rows = [
        {
            "Scryfall ID": ids[printing],
            "Quantity": str(quantity),
            "Finish": finish,
            "Altered": altered,
            "Location": location,
        }
        for printing, quantity, finish, altered, location in [
            (0, 3, "nonfoil", "false", "Red binder"),
            (0, 2, "foil", "false", "Box 4"),
            (0, 4, "unknown", "false", "Red binder"),
            (0, 1, "nonfoil", "true", "Red binder"),
            (1, 1, "nonfoil", "false", "Red binder"),
            (2, 1, "foil", "false", "Red binder"),
        ]
    ]
    commit(client, preview(client, rows))
    with session_factory()() as db, db.begin():
        for printing, provider, finish, price in [
            (0, "tcgplayer", "foil", "10"),
            (0, "manapool", "nonfoil", "6"),
            (1, "manapool", "nonfoil", "0.75"),
        ]:
            db.add(
                CardPrice(
                    printing_id=uuid.UUID(ids[printing]),
                    provider=provider,
                    finish=finish,
                    amount=Decimal(price),
                )
            )
    path = "/api/v1/collection/cards"
    assert client.get(path).json()["copies"] == 12
    for params, copies, value in [
        ({"min_price": "1", "max_price": "1"}, 3, "3"),
        ({"min_price": "5", "max_price": "10"}, 3, "25"),
        ({"max_price": "5"}, 4, "8"),
        ({"min_price": "0"}, 6, "28"),
        ({"min_price": "0", "max_price": "0"}, 0, None),
        ({"min_price": "10.01"}, 0, None),
        ({"min_price": "1", "finish": "unknown"}, 0, None),
        ({"min_price": "5", "rarity": "rare"}, 1, "5"),
        ({"min_price": "5", "max_price": "10", "provider": "manapool"}, 3, "18"),
        ({"max_price": "1", "provider": "manapool"}, 1, "0.75"),
        ({"min_price": "0", "provider": "cardkingdom"}, 0, None),
    ]:
        response = client.get(path, params=params)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["copies"] == copies
        assert result["valuation"]["priced_copies"] == copies
        assert result["valuation"]["unpriced_copies"] == 0
        amount = result["valuation"]["amount"]
        assert (Decimal(amount) if amount is not None else None) == (
            Decimal(value) if value is not None else None
        )
    # The quote range applies before grouping, location counts and pagination.
    result = client.get(path, params={"min_price": "10"}).json()
    assert result["items"][0]["quantity"] == 2
    assert result["items"][0]["locations"][0]["name"] == "Box 4"
    result = client.get(path, params={"min_price": "5", "max_price": "10", "offset": 40}).json()
    assert result["copies"] == 3 and result["items"] == []
    assert other.get(path, params={"min_price": "0"}).json()["copies"] == 0
    for params in [
        {"min_price": "5", "max_price": "4"},
        {"min_price": "-1"},
        {"max_price": "-0.01"},
        {"min_price": "NaN"},
        {"max_price": "Infinity"},
        {"max_price": "1.00001"},
    ]:
        assert client.get(path, params=params).status_code == 422
