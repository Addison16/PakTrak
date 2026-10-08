import secrets
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import delete, select
from test_collections import commit, key, preview

from scanner.db import session_factory
from scanner.models import (
    AccountEvent,
    CardPrice,
    CardPriceHistory,
    CatalogSnapshot,
    CollectionValueHistory,
    Printing,
    User,
)
from scanner.price_history import record_history

NAMES = ["Lantern Owl", "Copper Drake", "Quiet Orchard", "Glass Tutor"]


@pytest.fixture(scope="module")
def cards(isolated_database):
    """Set "fx1" #1-4 in English, a German #1, and a reprint of Lantern Owl in "fx2"."""
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic social fixture", checksum=secrets.token_hex(32), printings=6
        )
        db.add(snapshot)
        db.flush()
        printings = []
        for index, name in enumerate(NAMES):
            printings.append(
                Printing(
                    id=uuid.uuid4(),
                    oracle_id=uuid.uuid4(),
                    name=name,
                    set_code="fx1",
                    collector_number=str(index + 1),
                    language="en",
                    finishes=["nonfoil", "foil"],
                    snapshot_id=snapshot.id,
                    source_json={
                        "set_name": "Fixture Set",
                        "released_at": "2026-01-01",
                        "cmc": index + 1,
                        "type_line": "Creature",
                    },
                )
            )
        printings.append(
            Printing(
                id=uuid.uuid4(),
                oracle_id=printings[0].oracle_id,
                name=NAMES[0],
                set_code="fx1",
                collector_number="1",
                language="de",
                finishes=["nonfoil"],
                snapshot_id=snapshot.id,
                source_json={"set_name": "Fixture Set"},
            )
        )
        printings.append(
            Printing(
                id=uuid.uuid4(),
                oracle_id=printings[0].oracle_id,
                name=NAMES[0],
                set_code="fx2",
                collector_number="7",
                language="en",
                finishes=["nonfoil"],
                snapshot_id=snapshot.id,
                source_json={"set_name": "Fixture Reprints"},
            )
        )
        db.add_all(printings)
        db.flush()
        for printing, finish, amount in [
            (printings[0], "nonfoil", "2.00"),
            (printings[0], "foil", "6.00"),
            (printings[1], "nonfoil", "10.00"),
            (printings[2], "foil", "1.50"),
            (printings[3], "nonfoil", "40.00"),
            (printings[5], "nonfoil", "1.00"),
        ]:
            db.add(
                CardPrice(
                    printing_id=printing.id,
                    provider="tcgplayer",
                    finish=finish,
                    amount=Decimal(amount),
                )
            )
        ids, snapshot_id = [str(p.id) for p in printings], snapshot.id
    yield ids
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_([uuid.UUID(i) for i in ids])))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def own(client, printing_id, quantity=1, foil=False, binder="Red binder"):
    commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": printing_id,
                    "Quantity": str(quantity),
                    "Foil": "foil" if foil else "nonfoil",
                    "Binder Name": binder,
                }
            ],
        ),
    )


def befriend(alice, bob):
    code = alice.post("/api/v1/friends/code", json={"action": "new"}).json()["code"]
    assert bob.post("/api/v1/friends/requests", json={"code": code}).json() == {
        "state": "pending",
        "name": None,
    }
    request = alice.get("/api/v1/friends").json()["incoming"][0]
    assert alice.post(f"/api/v1/friends/requests/{request['id']}/accept").status_code == 200
    return request["id"]


def test_wishlist_merges_prices_paste_and_import_rows(clients, cards):
    client, _ = clients()
    own(client, cards[5], 2)
    response = client.post(
        "/api/v1/wishlist",
        json={"items": [{"printing_id": cards[0]}, {"printing_id": cards[0], "quantity": 2}]},
    )
    assert response.json() == {"added": 3}
    client.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[2], "finish": "foil"}]})
    data = client.get("/api/v1/wishlist").json()
    owl = next(item for item in data["items"] if item["printing"]["id"] == cards[0])
    # "Any finish" uses the cheapest priced finish; the reprint counts as owned.
    assert (owl["quantity"], owl["unit_amount"], owl["price_finish"], owl["owned"]) == (
        3,
        "2.00",
        "nonfoil",
        2,
    )
    assert data["amount"] == "7.50"
    # Changing to a finish already listed merges the two entries.
    orchard = next(item for item in data["items"] if item["printing"]["id"] == cards[2])
    client.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[2]}]})
    any_orchard = next(
        item
        for item in client.get("/api/v1/wishlist").json()["items"]
        if item["printing"]["id"] == cards[2] and item["finish"] == "any"
    )
    edited = client.post(
        f"/api/v1/wishlist/{any_orchard['id']}",
        json={"quantity": 2, "finish": "foil", "notes": ""},
    )
    assert edited.json()["id"] == orchard["id"]
    assert [
        item["quantity"]
        for item in client.get("/api/v1/wishlist").json()["items"]
        if item["printing"]["id"] == cards[2]
    ] == [3]
    assert client.delete(f"/api/v1/wishlist/{orchard['id']}").status_code == 200

    pasted = client.post(
        "/api/v1/wishlist/paste", json={"content": "2 Copper Drake\n1 Not A Real Card"}
    ).json()
    assert pasted["added"] == 2
    assert [row["name"] for row in pasted["unresolved"]] == ["Not A Real Card"]

    batch = preview(
        client,
        [
            {"Scryfall ID": cards[3], "Quantity": "4", "Binder Type": "wishlist"},
            {"Scryfall ID": cards[1], "Quantity": "1", "Binder Type": "binder"},
        ],
    )
    assert batch["summary"]["wishlist_rows"] == 1
    assert client.post(f"/api/v1/wishlist/from-import/{batch['id']}").json() == {"added": 4}
    # A second tap adds nothing, and the import stops offering it.
    assert client.post(f"/api/v1/wishlist/from-import/{batch['id']}").status_code == 409
    assert client.get(f"/api/v1/imports/{batch['id']}").json()["summary"]["wishlist_rows"] == 0
    other, _ = clients()
    assert other.post(f"/api/v1/wishlist/from-import/{batch['id']}").status_code == 404
    assert other.get("/api/v1/wishlist").json()["items"] == []


def test_friend_codes_stay_private_and_rate_limited(clients, cards):
    alice, alice_id = clients()
    bob, bob_id = clients()
    assert alice.get("/api/v1/friends").json()["code"] is None
    code = alice.post("/api/v1/friends/code", json={"action": "new"}).json()["code"]
    assert len(code) == 11 and code[5] == "-"
    assert alice.post("/api/v1/friends/requests", json={"code": code}).status_code == 422

    # Lowercase and missing dash still match; who owns the code stays hidden until accepted.
    sent = bob.post("/api/v1/friends/requests", json={"code": code.replace("-", "").lower()})
    assert sent.json() == {"state": "pending", "name": None}
    assert bob.get("/api/v1/friends").json()["outgoing"][0].keys() == {"id", "created_at"}
    incoming = alice.get("/api/v1/friends").json()["incoming"]
    assert incoming[0]["name"] == "Test collector"
    assert bob.get(f"/api/v1/friends/{alice_id}/collection").status_code == 404

    # Entering the other person's code answers their waiting request.
    bob_code = bob.post("/api/v1/friends/code", json={"action": "new"}).json()["code"]
    assert alice.post("/api/v1/friends/requests", json={"code": bob_code}).json()["state"] == (
        "accepted"
    )
    assert alice.get("/api/v1/friends").json()["friends"][0]["user_id"] == str(bob_id)

    # Turning a code off makes it unknown, with the same answer as a code that never existed.
    alice.post("/api/v1/friends/code", json={"action": "off"})
    carol, carol_id = clients()
    missing = carol.post("/api/v1/friends/requests", json={"code": code})
    assert missing.status_code == 404
    unknown = carol.post("/api/v1/friends/requests", json={"code": "ZZZZZ-ZZZZZ"})
    assert unknown.json()["detail"] == missing.json()["detail"]
    for _ in range(8):
        carol.post("/api/v1/friends/requests", json={"code": "ZZZZZ-ZZZZZ"})
    assert carol.post("/api/v1/friends/requests", json={"code": bob_code}).status_code == 429
    with session_factory()() as db, db.begin():
        db.execute(delete(AccountEvent).where(AccountEvent.owner_id == carol_id))


def test_friend_collection_hides_locations_and_respects_sharing(clients, cards):
    alice, alice_id = clients()
    bob, bob_id = clients()
    own(alice, cards[1], 2, binder="Secret shoebox")
    alice.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[3], "notes": "private"}]})
    own(bob, cards[3], 1)
    bob.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[1]}]})
    friendship = befriend(alice, bob)

    shared = bob.get(f"/api/v1/friends/{alice_id}/collection").json()
    assert shared["copies"] == 2
    assert shared["items"][0]["locations"] == []
    assert "Secret shoebox" not in str(shared)
    wishlist = bob.get(f"/api/v1/friends/{alice_id}/wishlist").json()
    assert wishlist["items"][0]["owned"] == 1 and "notes" not in wishlist["items"][0]
    matches = bob.get(f"/api/v1/friends/{alice_id}/matches").json()
    assert [item["printing"]["name"] for item in matches["they_have"]] == ["Copper Drake"]
    assert [item["printing"]["name"] for item in matches["you_have"]] == ["Glass Tutor"]

    alice.post("/api/v1/friends/settings", json={"share_collection": False, "share_wishlist": True})
    assert bob.get(f"/api/v1/friends/{alice_id}/collection").status_code == 403
    assert bob.get(f"/api/v1/friends/{alice_id}/matches").json()["they_have"] == []

    assert bob.delete(f"/api/v1/friends/{friendship}").status_code == 200
    assert bob.get(f"/api/v1/friends/{alice_id}/wishlist").status_code == 404
    assert alice.get("/api/v1/friends").json()["friends"] == []
    del bob_id


def waiting(client):
    return client.get("/api/auth/session").json()["trade_offers_waiting"]


def test_trade_offers_follow_each_side(clients, cards):
    alice, alice_id = clients()
    bob, bob_id = clients()
    own(alice, cards[1], 1)
    own(bob, cards[0], 2, foil=True)
    stranger, _ = clients()
    offer = {
        "friend_id": str(bob_id),
        "give": [{"printing_id": cards[1], "finish": "nonfoil", "quantity": 1}],
        "get": [{"printing_id": cards[0], "finish": "foil", "quantity": 2}],
        "message": "Owls for the drake?",
    }
    assert alice.post("/api/v1/trade-offers", json=offer, headers=key()).status_code == 404
    befriend(alice, bob)
    too_many = {**offer, "get": [{**offer["get"][0], "quantity": 3}]}
    refused = alice.post("/api/v1/trade-offers", json=too_many, headers=key())
    assert refused.status_code == 409 and "has 2 foil copies" in refused.json()["detail"]

    request_key = key()
    sent = alice.post("/api/v1/trade-offers", json=offer, headers=request_key)
    assert sent.status_code == 201, sent.text
    assert (
        alice.post("/api/v1/trade-offers", json=offer, headers=request_key).json()["id"]
        == (sent.json()["id"])
    )
    mine = sent.json()
    assert (mine["give_amount"], mine["get_amount"], mine["attention"]) == ("10.00", "12.00", None)

    inbox = bob.get("/api/v1/trade-offers").json()
    theirs = inbox["items"][0]
    assert inbox["attention"] == 1 and theirs["attention"] == "respond"
    # The session carries the same count, for the menu and the Home notice.
    assert waiting(bob) == 1 and waiting(alice) == 0
    assert theirs["friend"]["id"] == str(alice_id)
    assert [card["printing"]["name"] for card in theirs["give"]] == ["Lantern Owl"]
    assert [card["printing"]["name"] for card in theirs["get"]] == ["Copper Drake"]
    assert stranger.post(f"/api/v1/trade-offers/{theirs['id']}/accept").status_code == 404
    assert alice.post(f"/api/v1/trade-offers/{theirs['id']}/accept").status_code == 404

    accepted = bob.post(f"/api/v1/trade-offers/{theirs['id']}/accept").json()
    assert (accepted["state"], accepted["attention"]) == ("accepted", "apply")
    assert bob.post(f"/api/v1/trade-offers/{theirs['id']}/decline").status_code == 409
    assert alice.get("/api/v1/trade-offers").json()["items"][0]["attention"] == "apply"
    assert waiting(alice) == 1 and waiting(bob) == 1
    bob.post(f"/api/v1/trade-offers/{theirs['id']}/applied")
    alice.post(f"/api/v1/trade-offers/{theirs['id']}/applied")
    assert alice.get("/api/v1/trade-offers").json()["attention"] == 0
    assert bob.get("/api/v1/trade-offers").json()["attention"] == 0

    # A declined offer tells the sender once; removing a friend cancels waiting offers.
    second = alice.post("/api/v1/trade-offers", json=offer, headers=key()).json()
    bob.post(f"/api/v1/trade-offers/{second['id']}/decline")
    notice = alice.get("/api/v1/trade-offers").json()["items"][0]
    assert notice["attention"] == "declined"
    assert waiting(alice) == 1 and waiting(bob) == 0
    alice.post(f"/api/v1/trade-offers/{second['id']}/close")
    assert alice.get("/api/v1/trade-offers").json()["attention"] == 0
    third = alice.post("/api/v1/trade-offers", json=offer, headers=key()).json()
    friendship = alice.get("/api/v1/friends").json()["friends"][0]["id"]
    alice.delete(f"/api/v1/friends/{friendship}")
    assert bob.get("/api/v1/trade-offers").json()["items"][0]["id"] == third["id"]
    assert bob.get("/api/v1/trade-offers").json()["items"][0]["state"] == "cancelled"
    assert bob.get("/api/v1/trade-offers").json()["attention"] == 0
    assert waiting(alice) == 0 and waiting(bob) == 0


def test_value_and_price_history_record_owned_cards(clients, cards):
    client, owner_id = clients()
    own(client, cards[1], 2)
    own(client, cards[0], 1, foil=True)
    client.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[3]}]})
    with session_factory()() as db, db.begin():
        record_history(db, "tcgplayer")
        db.add(
            CollectionValueHistory(
                owner_id=owner_id,
                provider="tcgplayer",
                day=date.today() - timedelta(days=3),
                amount=Decimal("20.00"),
                priced_copies=3,
                copies=3,
            )
        )
        db.add(
            CardPriceHistory(
                printing_id=uuid.UUID(cards[1]),
                provider="tcgplayer",
                finish="nonfoil",
                day=date.today() - timedelta(days=3),
                amount=Decimal("8.00"),
            )
        )
        saved = db.scalar(
            select(CollectionValueHistory).where(
                CollectionValueHistory.owner_id == owner_id,
                CollectionValueHistory.day == date.today(),
            )
        )
        assert (saved.amount, saved.priced_copies, saved.copies) == (Decimal("26.0000"), 3, 3)
        recorded = set(
            db.scalars(
                select(CardPriceHistory.printing_id).where(
                    CardPriceHistory.day == date.today(),
                    CardPriceHistory.printing_id.in_([uuid.UUID(card) for card in cards]),
                )
            )
        )
        # Owned and wanted printings only; the unowned reprint isn't recorded.
        assert recorded == {uuid.UUID(cards[0]), uuid.UUID(cards[1]), uuid.UUID(cards[3])}
    history = client.get("/api/v1/collection/value-history").json()
    assert [point["amount"] for point in history["points"]] == ["20.00", "26.00"]
    assert history["change"] == {
        "amount": "6.00",
        "percent": 30.0,
        "since": (date.today() - timedelta(days=3)).isoformat(),
    }
    prices = client.get(f"/api/v1/collection/printings/{cards[1]}/price-history").json()
    assert [p["amount"] for p in prices["finishes"]["nonfoil"]["points"]] == ["8.00", "10.00"]
    assert prices["finishes"]["foil"]["points"] == []
    with session_factory()() as db, db.begin():
        db.execute(
            delete(CardPriceHistory).where(
                CardPriceHistory.printing_id.in_([uuid.UUID(card) for card in cards])
            )
        )


def test_sets_decks_and_deck_exports(clients, cards):
    client, owner_id = clients()
    own(client, cards[4], 1)  # German #1 counts toward set fx1's #1
    own(client, cards[2], 3)
    own(client, cards[5], 1)
    sets = {item["code"]: item for item in client.get("/api/v1/collection/sets").json()["items"]}
    assert (sets["fx1"]["owned"], sets["fx1"]["total"]) == (2, 4)
    assert (sets["fx2"]["owned"], sets["fx2"]["total"]) == (1, 1)
    detail = client.get("/api/v1/collection/sets/fx1").json()
    assert [card["printing"]["collector_number"] for card in detail["cards"]] == [
        "1",
        "2",
        "3",
        "4",
    ]
    assert detail["cards"][0]["printing"]["language"] == "en"
    assert [card["owned"] for card in detail["cards"]] == [1, 0, 3, 0]
    assert (detail["cost_to_finish"], detail["missing_unpriced"]) == ("50.00", 0)

    for name in ("Owls", "Mixed"):
        deck = client.post(
            "/api/v1/decks",
            json={
                "name": name,
                "cards": [{"printing_id": cards[0], "quantity": 1, "section": "main"}]
                + (
                    [
                        {"printing_id": cards[5], "quantity": 1, "section": "sideboard"},
                        {"printing_id": cards[2], "quantity": 2, "section": "commander"},
                    ]
                    if name == "Mixed"
                    else []
                ),
            },
            headers=key(),
        )
        assert deck.status_code == 201, deck.text
    usage = client.get(f"/api/v1/collection/printings/{cards[0]}/decks").json()
    assert (usage["owned"], usage["used"], usage["free"]) == (2, 3, 0)
    assert [deck["name"] for deck in usage["decks"]] == ["Mixed", "Owls"]
    mixed = deck.json()
    owl = next(card for card in mixed["cards"] if card["printing"]["id"] == cards[0])
    assert [item["name"] for item in owl["other_decks"]] == ["Owls"]
    assert owl["printing"]["cmc"] == 1

    arena = client.get(f"/api/v1/decks/{mixed['id']}/download?format=arena").text
    assert arena == (
        "Commander\n2 Quiet Orchard (FX1) 3\n\nDeck\n1 Lantern Owl (FX1) 1\n\n"
        "Sideboard\n1 Lantern Owl (FX2) 7\n\n"
    )
    mtgo = client.get(f"/api/v1/decks/{mixed['id']}/download?format=mtgo")
    assert mtgo.text == "1 Lantern Owl\n\n1 Lantern Owl\n2 Quiet Orchard\n"
    assert "mtgo.txt" in mtgo.headers["content-disposition"]
    del owner_id


def test_scan_review_shows_copies_owned_elsewhere(clients, cards):
    from scanner.scan_batches import owned_elsewhere

    client, owner_id = clients()
    own(client, cards[0], 2, binder="Blue box")
    own(client, cards[5], 1, binder="Red binder")
    with session_factory()() as db:
        found = owned_elsewhere(db, owner_id, {"Lantern Owl", "Glass Tutor"}, set())
        assert found == {"lantern owl": {"copies": 3, "locations": ["Blue box", "Red binder"]}}
        assert db.get(User, owner_id) is not None


def test_offers_recheck_the_sender_and_emptied_collections_chart_zero(clients, cards):
    alice, alice_id = clients()
    bob, bob_id = clients()
    own(alice, cards[1], 1)
    befriend(alice, bob)
    offer = {
        "friend_id": str(bob_id),
        "give": [{"printing_id": cards[1], "finish": "nonfoil", "quantity": 1}],
        "get": [],
        "message": "",
    }
    sent = alice.post("/api/v1/trade-offers", json=offer, headers=key()).json()

    # Alice gives the card away elsewhere before Bob answers.
    lot = alice.get(f"/api/v1/collection?printing_id={cards[1]}").json()["items"][0]
    alice.post(
        f"/api/v1/collection/{lot['id']}/quantity",
        json={"expected_version": lot["version"], "quantity": 0},
        headers=key(),
    )
    refused = bob.post(f"/api/v1/trade-offers/{sent['id']}/accept")
    assert refused.status_code == 409 and "now has 0 nonfoil copies" in refused.json()["detail"]
    assert bob.get("/api/v1/trade-offers").json()["items"][0]["state"] == "pending"

    with session_factory()() as db, db.begin():
        db.add(
            CollectionValueHistory(
                owner_id=alice_id,
                provider="tcgplayer",
                day=date.today() - timedelta(days=2),
                amount=Decimal("10.00"),
                priced_copies=1,
                copies=1,
            )
        )
    points = alice.get("/api/v1/collection/value-history").json()["points"]
    assert [point["amount"] for point in points] == ["10.00", "0.00"]


def test_card_art_shows_for_wishlist_offers_and_shared_friends(clients, cards, monkeypatch):
    """Pictures for cards you want, cards on a trade offer and a friend's shared
    cards load like your own; a friend who stops sharing hides them again."""
    from scanner import card_images

    monkeypatch.setattr(
        card_images, "load_image", lambda card, face, size: (b"png", "image/png", "digest")
    )
    alice, alice_id = clients()
    bob, bob_id = clients()
    art = {identifier: f"/api/v1/card-images/{identifier}/0/grid" for identifier in cards[:4]}
    assert alice.get(art[cards[0]]).status_code == 404
    alice.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[0]}]})
    assert alice.get(art[cards[0]]).status_code == 200
    assert bob.get(art[cards[0]]).status_code == 404

    own(bob, cards[1], 1)
    bob.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[2]}]})
    befriend(alice, bob)
    assert alice.get(art[cards[1]]).status_code == 200  # Bob's shared collection.
    assert alice.get(art[cards[2]]).status_code == 200  # Bob's shared wishlist.
    assert alice.get(art[cards[3]]).status_code == 404
    bob.post("/api/v1/friends/settings", json={"share_collection": False, "share_wishlist": False})
    assert alice.get(art[cards[1]]).status_code == 404
    assert alice.get(art[cards[2]]).status_code == 404

    own(alice, cards[3], 1)
    bob.post("/api/v1/friends/settings", json={"share_collection": True, "share_wishlist": False})
    offer = {
        "friend_id": str(bob_id),
        "give": [{"printing_id": cards[3], "finish": "nonfoil", "quantity": 1}],
        "get": [{"printing_id": cards[1], "finish": "nonfoil", "quantity": 1}],
    }
    assert alice.post("/api/v1/trade-offers", json=offer, headers=key()).status_code == 201
    assert bob.get(art[cards[3]]).status_code == 200  # Offered to Bob.
    assert alice.get(art[cards[1]]).status_code == 200  # Asked from Bob.
