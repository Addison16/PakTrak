"""Home price alerts compare each owner's cards with the price that owner last saw."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import delete, select, update

from scanner.db import session_factory
from scanner.models import (
    Binder,
    CardPrice,
    CatalogSnapshot,
    InventoryLot,
    PriceAlertBaseline,
    Printing,
    User,
)

NAMES = ["Riser", "Faller", "Penny", "Steady", "Foil riser", "Misprint", "Drifter"]


@pytest.fixture
def market(clients):
    ids = {name: uuid.uuid4() for name in NAMES}
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic price alert fixture", checksum=uuid.uuid4().hex, printings=len(ids)
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        for index, (name, identifier) in enumerate(ids.items()):
            db.add(
                Printing(
                    id=identifier,
                    name=name,
                    set_code="alr",
                    collector_number=str(index),
                    language="en",
                    finishes=["nonfoil", "foil"],
                    snapshot_id=snapshot_id,
                    source_json={},
                )
            )
        db.flush()
        prices = {
            "Riser": ("nonfoil", "10"),
            "Faller": ("nonfoil", "20"),
            "Penny": ("nonfoil", "0.10"),
            "Steady": ("nonfoil", "5"),
            "Foil riser": ("foil", "4"),
            "Misprint": ("nonfoil", "8"),
            "Drifter": ("nonfoil", "10"),
        }
        for name, (finish, amount) in prices.items():
            for provider in ("tcgplayer", "cardkingdom"):
                db.add(
                    CardPrice(
                        printing_id=ids[name],
                        provider=provider,
                        finish=finish,
                        amount=Decimal(amount),
                    )
                )

    def own(owner_id, name, quantity=1, finish="nonfoil", **extra):
        with session_factory()() as db, db.begin():
            binder = db.scalar(select(Binder).where(Binder.owner_id == owner_id))
            if binder is None:
                binder = Binder(owner_id=owner_id, name="Alerts", kind="binder")
                db.add(binder)
                db.flush()
            db.add(
                InventoryLot(
                    owner_id=owner_id,
                    binder_id=binder.id,
                    printing_id=ids[name],
                    quantity_remaining=quantity,
                    finish=finish,
                    **extra,
                )
            )

    def price(name, amount, finish="nonfoil", provider="tcgplayer"):
        with session_factory()() as db, db.begin():
            db.execute(
                update(CardPrice)
                .where(
                    CardPrice.printing_id == ids[name],
                    CardPrice.finish == finish,
                    CardPrice.provider == provider,
                )
                .values(amount=Decimal(amount))
            )

    yield ids, own, price
    with session_factory()() as db, db.begin():
        values = list(ids.values())
        db.execute(delete(InventoryLot).where(InventoryLot.printing_id.in_(values)))
        db.execute(delete(Printing).where(Printing.id.in_(values)))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def alerts(client):
    response = client.get("/api/v1/price-alerts")
    assert response.status_code == 200, response.text
    return response.json()


def names(result, key):
    return [item["name"] for item in result[key]]


def test_first_visit_sets_baselines_and_later_moves_alert(clients, market):
    ids, own, price = market
    client, owner_id = clients()
    for name in ["Riser", "Faller", "Penny", "Steady", "Drifter"]:
        own(owner_id, name, quantity=3 if name == "Riser" else 1)
    own(owner_id, "Foil riser", finish="foil")
    own(owner_id, "Misprint", misprint=True)

    first = alerts(client)
    assert first["settings"] == {"enabled": True, "percent": 20, "amount": "1.00"}
    assert first["rises"] == first["drops"] == []
    with session_factory()() as db:
        watched = db.scalars(
            select(PriceAlertBaseline.printing_id).where(PriceAlertBaseline.owner_id == owner_id)
        ).all()
    # Misprints carry their own value, so their market quote is never watched.
    assert ids["Misprint"] not in watched and len(watched) == 6

    price("Riser", "14")  # +40%, +$4 on each of 3 copies
    price("Faller", "15")  # -25%, -$5
    price("Penny", "0.50")  # +400% but only +$0.40
    price("Steady", "5.50")  # +$0.50, +10%
    price("Foil riser", "6", finish="foil")  # +50%, +$2
    price("Misprint", "80")
    price("Drifter", "11")  # +10%: below the threshold for now
    result = alerts(client)
    assert names(result, "rises") == ["Riser", "Foil riser"]
    assert names(result, "drops") == ["Faller"]
    assert (result["rise_count"], result["drop_count"]) == (2, 1)
    riser = result["rises"][0]
    assert riser | {"since": None} == riser | {
        "old_amount": "10.00",
        "new_amount": "14.00",
        "change": "4.00",
        "percent": 40.0,
        "quantity": 3,
        "finish": "nonfoil",
        "since": None,
    }
    assert result["drops"][0]["change"] == "-5.00"
    # Viewing again without dismissing keeps the same notice.
    assert names(alerts(client), "rises") == ["Riser", "Foil riser"]

    response = client.post(
        "/api/v1/price-alerts/seen",
        json={
            "cards": [
                {"printing_id": item["printing_id"], "finish": item["finish"]}
                for item in result["rises"] + result["drops"]
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"updated": 3}
    cleared = alerts(client)
    assert cleared["rises"] == cleared["drops"] == []

    # Undismissed drift keeps its original baseline and alerts once it adds up.
    price("Drifter", "12.50")
    assert names(alerts(client), "rises") == ["Drifter"]


def test_each_account_has_its_own_threshold_and_baselines(clients, market):
    _, own, price = market
    first, first_id = clients()
    second, second_id = clients()
    own(first_id, "Riser")
    own(second_id, "Riser")
    alerts(first)
    price("Riser", "11")
    alerts(second)  # The second owner first sees the card at $11.

    response = second.put(
        "/api/v1/price-alerts/settings", json={"enabled": True, "percent": 5, "amount": None}
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": True, "percent": 5, "amount": None}
    price("Riser", "11.70")
    # +17% / +$1.70 for the first owner misses 20%; +6.4% passes 5% for the second.
    assert alerts(first)["rises"] == []
    assert names(alerts(second), "rises") == ["Riser"]
    assert alerts(second)["rises"][0]["old_amount"] == "11.00"
    with session_factory()() as db:
        assert db.get(User, first_id).price_alert_percent == 20

    response = first.put(
        "/api/v1/price-alerts/settings", json={"enabled": False, "percent": 20, "amount": "1.00"}
    )
    assert response.status_code == 200, response.text
    price("Riser", "30")
    assert alerts(first)["rises"] == []


def test_settings_need_a_threshold_when_enabled(clients):
    client, _ = clients()
    for body in (
        {"enabled": True, "percent": None, "amount": None},
        {"enabled": True, "percent": 0, "amount": None},
        {"enabled": True, "percent": None, "amount": "-1"},
        {"enabled": True, "percent": None, "amount": "1.234"},
    ):
        assert client.put("/api/v1/price-alerts/settings", json=body).status_code == 422
    response = client.put(
        "/api/v1/price-alerts/settings", json={"enabled": False, "percent": None, "amount": None}
    )
    assert response.json() == {"enabled": False, "percent": None, "amount": None}


def test_switching_price_source_restarts_baselines(clients, market):
    _, own, price = market
    client, owner_id = clients()
    own(owner_id, "Riser")
    alerts(client)
    price("Riser", "40", provider="cardkingdom")
    response = client.patch("/api/auth/preferences", json={"price_source": "cardkingdom"})
    assert response.status_code == 200, response.text
    # Comparing TCGplayer's $10 with Card Kingdom's $40 would be a false alert.
    assert alerts(client)["rises"] == []
    price("Riser", "50", provider="cardkingdom")
    assert alerts(client)["rises"][0]["old_amount"] == "40.00"


def test_removed_cards_stop_being_watched_and_others_cannot_dismiss(clients, market):
    ids, own, price = market
    client, owner_id = clients()
    stranger, _ = clients()
    own(owner_id, "Faller")
    alerts(client)
    price("Faller", "10")
    card = {"printing_id": str(ids["Faller"]), "finish": "nonfoil"}
    assert stranger.post("/api/v1/price-alerts/seen", json={"cards": [card]}).json() == {
        "updated": 0
    }
    assert names(alerts(client), "drops") == ["Faller"]
    with session_factory()() as db, db.begin():
        db.execute(
            update(InventoryLot)
            .where(InventoryLot.owner_id == owner_id)
            .values(quantity_remaining=0)
        )
    assert alerts(client)["drops"] == []
    with session_factory()() as db:
        assert not db.scalars(
            select(PriceAlertBaseline).where(PriceAlertBaseline.owner_id == owner_id)
        ).all()


def test_a_re_added_card_starts_fresh_even_before_the_next_visit(clients, market):
    ids, own, price = market
    client, owner_id = clients()
    own(owner_id, "Riser")
    own(owner_id, "Faller", misprint=True)
    own(owner_id, "Faller")
    alerts(client)
    with session_factory()() as db, db.begin():
        db.execute(
            update(InventoryLot)
            .where(InventoryLot.owner_id == owner_id, InventoryLot.misprint.is_not(True))
            .values(quantity_remaining=0)
        )
    # Both come back as new copies, and prices move, before Home is opened again.
    own(owner_id, "Riser")
    own(owner_id, "Faller")
    price("Riser", "30")
    price("Faller", "5")
    # The leftover misprint can't keep the old Faller price alive either.
    result = alerts(client)
    assert result["rises"] == result["drops"] == []
    price("Riser", "40")
    assert alerts(client)["rises"][0]["old_amount"] == "30.00"
