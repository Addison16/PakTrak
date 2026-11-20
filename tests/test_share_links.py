"""Read-only share links for a deck or the wishlist."""

from test_collections import catalog as catalog
from test_collections import key

from scanner.db import session_factory
from scanner.models import User


def deck(client, catalog, name="Friday night"):
    response = client.post(
        "/api/v1/decks",
        headers=key(),
        json={
            "name": name,
            "format": "casual",
            "notes": "Private plan: beat my brother",
            "cards": [
                {"printing_id": catalog[0], "quantity": 4, "section": "main"},
                {"printing_id": catalog[1], "quantity": 1, "section": "sideboard"},
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_a_deck_link_shows_only_the_list_and_stops_when_turned_off(clients, catalog):
    client, owner = clients()
    stranger, _ = clients()
    deck_id = deck(client, catalog)
    assert client.get("/api/v1/shares").json() == {"items": []}
    made = client.post("/api/v1/shares", json={"kind": "deck", "deck_id": deck_id})
    assert made.status_code == 201, made.text
    link = made.json()
    # Asking again returns the same link rather than a second one.
    assert client.post("/api/v1/shares", json={"kind": "deck", "deck_id": deck_id}).json() == link
    assert [item["id"] for item in client.get("/api/v1/shares").json()["items"]] == [link["id"]]
    assert stranger.get("/api/v1/shares").json() == {"items": []}
    # Nobody can share someone else's deck, or turn off someone else's link.
    other = stranger.post("/api/v1/shares", json={"kind": "deck", "deck_id": deck_id})
    assert other.status_code == 404
    stranger.delete(f"/api/v1/shares/{link['id']}")

    from fastapi.testclient import TestClient

    from scanner.api import app
    from scanner.settings import get_settings

    visitor = TestClient(app, base_url=get_settings().app_url)
    path = f"/api/public/shares/{link['token']}"
    shown = visitor.get(path)
    assert shown.status_code == 200, shown.text
    assert "noindex" in shown.headers["x-robots-tag"]
    data = shown.json()
    assert (data["kind"], data["name"], data["copies"]) == ("deck", "Friday night", 5)
    assert [(card["section"], card["quantity"]) for card in data["cards"]] == [
        ("main", 4),
        ("sideboard", 1),
    ]
    # No notes, no account name, no account or deck identifiers.
    text = shown.text
    assert "brother" not in text and "Test collector" not in text
    assert str(owner) not in text and deck_id not in text
    assert visitor.get("/api/public/shares/" + "x" * 43).status_code == 404
    assert visitor.get("/api/public/shares/short").status_code == 404
    # Card art is served for listed cards only.
    import uuid

    missing = visitor.get(f"{path}/images/{uuid.uuid4()}")
    assert missing.status_code == 404
    # A visitor's link gives no way into the signed-in API.
    assert visitor.get("/api/v1/decks").status_code == 401

    # A suspended account's links stop, and come back with the account.
    for suspended, status in ((True, 404), (False, 200)):
        with session_factory()() as db, db.begin():
            db.get(User, owner).suspended = suspended
        assert visitor.get(path).status_code == status

    # Archiving the deck hides it; turning the link off ends it for good.
    removed = client.delete(f"/api/v1/shares/{link['id']}")
    assert removed.status_code == 200
    assert visitor.get(path).status_code == 404
    again = client.post("/api/v1/shares", json={"kind": "deck", "deck_id": deck_id}).json()
    assert again["token"] != link["token"]


def test_a_wishlist_link_lists_wanted_cards_without_notes(clients, catalog):
    client, _ = clients()
    added = client.post(
        "/api/v1/wishlist",
        headers=key(),
        json={"items": [{"printing_id": catalog[0], "quantity": 2, "finish": "foil"}]},
    )
    assert added.status_code == 200, added.text
    assert client.post("/api/v1/shares", json={"kind": "wishlist", "deck_id": None}).status_code
    bad = client.post("/api/v1/shares", json={"kind": "wishlist", "deck_id": catalog[0]})
    assert bad.status_code == 422
    assert client.post("/api/v1/shares", json={"kind": "deck"}).status_code == 422
    link = client.post("/api/v1/shares", json={"kind": "wishlist"}).json()
    from fastapi.testclient import TestClient

    from scanner.api import app
    from scanner.settings import get_settings

    visitor = TestClient(app, base_url=get_settings().app_url)
    data = visitor.get(f"/api/public/shares/{link['token']}").json()
    assert data["kind"] == "wishlist" and data["copies"] == 2
    assert [(card["quantity"], card["finish"]) for card in data["cards"]] == [(2, "foil")]
    assert "notes" not in data["cards"][0] and "name" not in data
