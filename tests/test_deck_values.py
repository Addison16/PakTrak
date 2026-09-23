import secrets
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from test_collections import key

from scanner.api import app
from scanner.db import session_factory
from scanner.deck_values import value_report
from scanner.models import CardPrice, CatalogSnapshot, Deck, Printing
from scanner.settings import get_settings


@pytest.fixture(scope="module")
def value_catalog(isolated_database):
    names = [
        "Shared name",
        "Shared name",
        "Foil edition",
        "Etched edition",
        "Missing regular quote",
        "No finishes",
    ]
    finishes = [["nonfoil", "foil"], ["nonfoil"], ["foil"], ["etched"], ["nonfoil", "foil"], []]
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic deck values", checksum=secrets.token_hex(32), printings=6
        )
        db.add(snapshot)
        db.flush()
        cards = [
            Printing(
                id=uuid.uuid4(),
                name=name,
                set_code="val",
                collector_number=str(index),
                language="en",
                finishes=finishes[index],
                source_json={},
                snapshot_id=snapshot.id,
            )
            for index, name in enumerate(names)
        ]
        db.add_all(cards)
        db.flush()
        ids, snapshot_id = [str(card.id) for card in cards], snapshot.id
        for provider, multiplier in [("tcgplayer", 1), ("cardkingdom", 2), ("manapool", 3)]:
            for index, finish, amount in [
                (0, "nonfoil", "0.1001"),
                (0, "foil", "5.5"),
                (1, "nonfoil", "25.0"),
                (2, "foil", "2.0"),
                (3, "etched", "3.0"),
                (4, "foil", "100.0"),
                (5, "nonfoil", "30"),
            ]:
                db.add(
                    CardPrice(
                        printing_id=cards[index].id,
                        provider=provider,
                        finish=finish,
                        amount=Decimal(amount) * multiplier,
                        available=False,
                    )
                )
    yield ids
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_([uuid.UUID(id) for id in ids])))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def choices(ids):
    return [
        {"printing_id": ids[index], "section": section, "quantity": quantity}
        for index, section, quantity in [
            (0, "commander", 1),
            (0, "main", 30),
            (1, "sideboard", 2),
            (2, "main", 1),
            (3, "main", 1),
            (4, "main", 2),
            (5, "main", 1),
        ]
    ]


def report(client, ids, **options):
    response = client.post(
        "/api/v1/decks/value", headers=key(), json={"cards": choices(ids), **options}
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(
    "provider,multiplier", [("tcgplayer", 1), ("cardkingdom", 2), ("manapool", 3)]
)
def test_exact_editions_copies_and_sections_use_only_the_selected_source(
    clients, value_catalog, provider, multiplier
):
    client, _ = clients()
    value = report(client, value_catalog, provider=provider)
    assert value["copies"] == 38 and value["priced_copies"] == 35 and value["unpriced_copies"] == 3
    assert Decimal(value["amount"]) == Decimal("58.1031") * multiplier
    assert Decimal(value["sections"]["commander"]["amount"]) == Decimal("0.1001") * multiplier
    assert Decimal(value["sections"]["main"]["amount"]) == Decimal("8.0030") * multiplier
    assert Decimal(value["sections"]["sideboard"]["amount"]) == Decimal("50") * multiplier
    assert value["fallback_copies"] == 2
    assert value["currency"] == "USD" and value["provider"] == provider
    # Retail out-of-stock quotes remain reference prices, as in Collection.
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0


def test_finish_preference_uses_supported_finishes_and_never_fills_missing_quotes(
    clients, value_catalog
):
    client, _ = clients()
    regular = report(client, value_catalog)
    missing = next(item for item in regular["items"] if item["printing_id"] == value_catalog[4])
    assert missing["finish"] == "nonfoil" and missing["amount"] is None
    assert missing["unpriced_reason"] == "missing_price" and not missing["finish_fallback"]
    absent = next(item for item in regular["items"] if item["printing_id"] == value_catalog[5])
    assert absent["finish"] is None and absent["unpriced_reason"] == "unknown_finish"
    foil = report(client, value_catalog, finish_preference="foil")
    assert Decimal(foil["amount"]) == Decimal("425.5")
    assert foil["priced_copies"] == 37 and foil["unpriced_copies"] == 1
    assert foil["fallback_copies"] == 3
    assert (
        next(item for item in foil["items"] if item["printing_id"] == value_catalog[1])["finish"]
        == "nonfoil"
    )
    etched = report(client, value_catalog, finish_preference="etched")
    assert Decimal(etched["amount"]) == Decimal(regular["amount"])


def test_missing_source_stays_unpriced_and_empty_deck_is_zero(clients, value_catalog):
    client, _ = clients()
    for cards, amount, count in [
        ([], "0", 0),
        ([{"printing_id": value_catalog[4], "quantity": 3, "section": "main"}], None, 3),
    ]:
        response = client.post("/api/v1/decks/value", headers=key(), json={"cards": cards})
        assert response.status_code == 200
        value = response.json()
        assert value["amount"] == amount and value["unpriced_copies"] == count
    with session_factory()() as db, db.begin():
        db.execute(
            delete(CardPrice).where(
                CardPrice.printing_id == uuid.UUID(value_catalog[1]),
                CardPrice.provider == "manapool",
            )
        )
    response = client.post(
        "/api/v1/decks/value",
        headers=key(),
        json={
            "cards": [{"printing_id": value_catalog[1], "quantity": 2, "section": "main"}],
            "provider": "manapool",
        },
    )
    assert response.json()["amount"] is None  # Other providers still have this edition.
    with session_factory()() as db, db.begin():
        db.add(
            CardPrice(
                printing_id=uuid.UUID(value_catalog[1]),
                provider="manapool",
                finish="nonfoil",
                amount=75,
            )
        )


def test_saved_deck_values_follow_account_source_and_update_quantities_without_changing_inventory(
    clients, value_catalog
):
    client, _ = clients()
    other, _ = clients()
    client.patch("/api/auth/preferences", json={"price_source": "cardkingdom"})
    response = client.post(
        "/api/v1/decks",
        headers=key(),
        json={"name": "Valued deck", "cards": choices(value_catalog)},
    )
    assert response.status_code == 201, response.text
    deck = response.json()
    assert deck["valuation"]["provider"] == "cardkingdom"
    assert Decimal(deck["valuation"]["amount"]) == Decimal("116.2062")
    assert other.get(f"/api/v1/decks/{deck['id']}").status_code == 404
    edited = client.post(
        f"/api/v1/decks/{deck['id']}",
        headers=key(),
        json={
            "name": deck["name"],
            "expected_version": deck["version"],
            "cards": [{"printing_id": value_catalog[0], "section": "main", "quantity": 100000}],
        },
    )
    assert edited.status_code == 200, edited.text
    assert Decimal(edited.json()["valuation"]["amount"]) == Decimal("20020.0000")
    reloaded = client.get(f"/api/v1/decks/{deck['id']}").json()
    assert reloaded["valuation"]["amount"] == edited.json()["valuation"]["amount"]
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"provider": "unexpected"},
        {"finish_preference": "unknown"},
        {"cards": [{"printing_id": str(uuid.uuid4()), "quantity": 1}]},
        {"cards": [], "amount": "100"},
    ],
)
def test_value_request_validation(clients, value_catalog, changes):
    client, _ = clients()
    response = client.post(
        "/api/v1/decks/value", headers=key(), json={"cards": choices(value_catalog), **changes}
    )
    assert response.status_code == 422


def test_private_validated_read_only_price_calculations(clients, value_catalog):
    client, owner = clients()
    with TestClient(app, base_url=get_settings().app_url) as anonymous:
        assert anonymous.post("/api/v1/decks/value", json={"cards": []}).status_code == 401
    assert (
        client.post(
            "/api/v1/decks/value", json={"cards": []}, headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )
    card = {"printing_id": value_catalog[0], "quantity": 1, "section": "main"}
    for cards in [
        [card, card],
        [{**card, "quantity": 0}],
        [{**card, "quantity": True}],
        [card] * 301,
    ]:
        assert (
            client.post("/api/v1/decks/value", headers=key(), json={"cards": cards}).status_code
            == 422
        )
    with session_factory()() as db:
        assert list(db.scalars(select(Deck).where(Deck.owner_id == owner))) == []


def test_price_reads_are_batched_and_invalid_numeric_quotes_are_excluded(clients, value_catalog):
    _, _owner = clients()
    with session_factory()() as db:
        printing = db.get(Printing, uuid.UUID(value_catalog[0]))
        rows = [
            (SimpleNamespace(quantity=100000, section=section), printing)
            for section in ("commander", "main", "sideboard")
        ]
        queries = []
        engine = db.get_bind()

        def count(*args):
            queries.append(args[2])

        event.listen(engine, "before_cursor_execute", count)
        try:
            value = value_report(db, rows)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(queries) == 2
        assert Decimal(value["amount"]) == Decimal("30030")
        quote = db.get(CardPrice, (printing.id, "tcgplayer", "nonfoil"))
        quote.amount = Decimal("NaN")
        db.flush()
        missing = value_report(db, rows)
        assert missing["amount"] is None and missing["unpriced_copies"] == 300000
        db.rollback()
