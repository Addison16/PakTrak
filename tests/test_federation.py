import json
import time
import uuid

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update
from test_social import cards, own  # noqa: F401

from scanner import federation
from scanner.api import app
from scanner.db import session_factory
from scanner.models import (
    FederationNonce,
    FederationPeer,
    RemoteFriendship,
    ServerFederation,
    User,
)
from scanner.settings import get_settings
from scanner.social import NOT_FOUND

PEER = "http://peer.test"


class FakePeer:
    """Another PakTrak server, answering this server's signed requests from a script."""

    def __init__(self):
        self.key = Ed25519PrivateKey.generate()
        self.public = federation.b64(self.key.public_key().public_bytes_raw())
        self.private = federation.b64(self.key.private_bytes_raw())
        self.received = []
        self.answers = {}

    def handle(self, request):
        path = request.url.path.removeprefix(federation.PREFIX)
        if request.method == "GET" and path == "/server":
            return httpx.Response(
                200,
                json={"software": "PakTrak", "protocol": 1, "url": PEER, "public_key": self.public},
            )
        body = request.read()
        with session_factory()() as db:
            ours = db.get(ServerFederation, 1).public_key
        # Everything this server sends must carry a signature from its published key.
        Ed25519PublicKey.from_public_bytes(federation.unb64(ours)).verify(
            federation.unb64(request.headers["PakTrak-Signature"]),
            federation.signing_text(
                "POST",
                str(request.url),
                request.headers["PakTrak-Origin"],
                int(request.headers["PakTrak-Date"]),
                request.headers["PakTrak-Nonce"],
                body,
            ),
        )
        assert request.headers["PakTrak-Origin"] == get_settings().app_url
        payload = json.loads(body)
        self.received.append((path, payload))
        status, answer = self.answers.get(path, (200, {}))
        if callable(answer):
            answer = answer(payload)
        return httpx.Response(status, json=answer)

    def post(self, path, payload, key=None, origin=PEER, nonce=None, date=None):
        """A signed request from this peer to the server under test."""
        body = json.dumps(payload).encode()
        target = get_settings().app_url + federation.PREFIX + path
        headers = federation.signed_headers(key or self.private, target, body, origin=origin)
        if nonce or date:
            headers["PakTrak-Nonce"] = nonce or headers["PakTrak-Nonce"]
            headers["PakTrak-Date"] = str(date or headers["PakTrak-Date"])
            signer = Ed25519PrivateKey.from_private_bytes(federation.unb64(key or self.private))
            headers["PakTrak-Signature"] = federation.b64(
                signer.sign(
                    federation.signing_text(
                        "POST",
                        target,
                        origin,
                        headers["PakTrak-Date"],
                        headers["PakTrak-Nonce"],
                        body,
                    )
                )
            )
        with TestClient(app, base_url=get_settings().app_url) as client:
            return client.post(federation.PREFIX + path, content=body, headers=headers)


def reset():
    with session_factory()() as db, db.begin():
        db.execute(delete(FederationPeer))
        db.execute(delete(FederationNonce))
        db.execute(update(ServerFederation).values(enabled=False))


@pytest.fixture
def peer(monkeypatch):
    fake = FakePeer()
    monkeypatch.setattr(get_settings(), "federation_allow_private_addresses", True)
    monkeypatch.setattr(
        federation,
        "http_client",
        lambda timeout=None: httpx.Client(transport=httpx.MockTransport(fake.handle)),
    )
    reset()
    yield fake
    reset()


def admin_of(clients):
    client, _ = clients("admin")
    assert client.post("/api/v1/servers/settings", json={"enabled": True}).status_code == 200
    return client


def connect(clients, peer):
    """Both admins approve: this server asks, and the peer's admin accepts."""
    admin = admin_of(clients)
    peer.answers["/connect"] = (200, {"state": "pending"})
    servers = admin.post("/api/v1/servers", json={"url": PEER})
    assert servers.status_code == 200, servers.text
    assert servers.json()["servers"][0]["state"] == "requested"
    assert peer.post("/accept", {}).json() == {"state": "connected"}
    return admin


def test_connections_stay_off_until_an_admin_turns_them_on(clients, peer):
    assert peer.post("/connect", {"url": PEER}).status_code == 404
    with TestClient(app, base_url=get_settings().app_url) as visitor:
        assert visitor.get(federation.PREFIX + "/server").status_code == 404
    member, _ = clients("member")
    assert member.get("/api/v1/servers").status_code == 403
    assert member.post("/api/v1/servers/settings", json={"enabled": True}).status_code == 403
    admin, _ = clients("admin")
    refused = admin.post("/api/v1/servers", json={"url": PEER})
    assert refused.status_code == 409

    admin.post("/api/v1/servers/settings", json={"enabled": True})
    with TestClient(app, base_url=get_settings().app_url) as visitor:
        info = visitor.get(federation.PREFIX + "/server").json()
    # The published details name the server and its key, and nothing about its accounts.
    assert info.keys() == {"software", "protocol", "url", "public_key"}
    assert admin.post("/api/v1/servers", json={"url": "ftp://peer.test"}).status_code == 422
    own_address = admin.post("/api/v1/servers", json={"url": get_settings().app_url})
    assert own_address.status_code == 422


def test_both_admins_approve_before_a_server_connects(clients, peer):
    admin = admin_of(clients)
    assert peer.post("/connect", {"url": PEER}).json() == {"state": "pending"}
    listed = admin.get("/api/v1/servers").json()["servers"]
    assert [(item["host"], item["state"]) for item in listed] == [("peer.test", "pending")]
    # Nothing else is answered until this server's admin approves.
    assert peer.post("/friend-requests", {}).status_code == 403

    approved = admin.post(f"/api/v1/servers/{listed[0]['id']}/approve")
    assert approved.json()["servers"][0]["state"] == "connected"
    assert peer.received[-1] == ("/accept", {})

    # Disconnecting while paused still tells the other server.
    admin.post("/api/v1/servers/settings", json={"enabled": False})
    removed = admin.delete(f"/api/v1/servers/{listed[0]['id']}")
    assert removed.json()["servers"] == []
    assert peer.received[-1] == ("/disconnect", {})


def test_requests_must_be_signed_by_the_connected_server(clients, peer):
    connect(clients, peer)
    impostor = Ed25519PrivateKey.generate()
    forged = peer.post(
        "/friends/removed",
        {"link_id": str(uuid.uuid4())},
        key=federation.b64(impostor.private_bytes_raw()),
    )
    assert forged.status_code == 401
    stranger = peer.post(
        "/friends/removed", {"link_id": str(uuid.uuid4())}, origin="http://other.test"
    )
    assert stranger.status_code == 403
    stale = peer.post(
        "/friends/removed", {"link_id": str(uuid.uuid4())}, date=int(time.time()) - 3600
    )
    assert stale.status_code == 401
    # The same signed request can't be played back.
    nonce = "n" * 32
    assert (
        peer.post("/friends/removed", {"link_id": str(uuid.uuid4())}, nonce=nonce).status_code
        == 200
    )
    replay = peer.post("/friends/removed", {"link_id": str(uuid.uuid4())}, nonce=nonce)
    assert replay.status_code == 401
    # A connect request must come from the server it names, signed with that server's key.
    with session_factory()() as db, db.begin():
        db.execute(delete(FederationPeer))
    lying = peer.post("/connect", {"url": PEER}, key=federation.b64(impostor.private_bytes_raw()))
    assert lying.status_code == 401
    assert peer.post("/connect", {"url": "http://elsewhere.test"}).status_code == 422


def remote_request(peer, code, name="Pat on peer", user_id=None, link_id=None):
    return peer.post(
        "/friend-requests",
        {
            "link_id": str(link_id or uuid.uuid4()),
            "code": code,
            "user": {"id": str(user_id or uuid.uuid4()), "name": name},
            "share_collection": True,
            "share_wishlist": False,
        },
    )


def test_friend_codes_stay_private_across_servers(clients, peer):
    connect(clients, peer)
    alice, alice_id = clients()
    code = alice.post("/api/v1/friends/code", json={"action": "new"}).json()["code"]

    unknown = remote_request(peer, "ZZZZZ-ZZZZZ")
    assert unknown.status_code == 404 and unknown.json()["detail"] == NOT_FOUND
    pat = uuid.uuid4()
    sent = remote_request(peer, code.lower().replace("-", ""), user_id=pat)
    answer = sent.json()
    # Who the code belongs to stays private until they accept.
    assert answer["state"] == "pending" and answer["user"]["name"] is None
    assert remote_request(peer, code, user_id=pat).json()["link_id"] == answer["link_id"]

    incoming = alice.get("/api/v1/friends").json()["incoming"]
    assert [(item["name"], item["server"]) for item in incoming] == [("Pat on peer", "peer.test")]
    accepted = alice.post(f"/api/v1/friends/requests/{incoming[0]['id']}/accept")
    assert accepted.status_code == 200, accepted.text
    path, told = peer.received[-1]
    assert path == "/friends/accepted" and told["link_id"] == answer["link_id"]
    assert told["user"] == {"id": str(alice_id), "name": "Test collector"}
    friends = alice.get("/api/v1/friends").json()["friends"]
    assert [(item["name"], item["server"], item["shares_collection"]) for item in friends] == [
        ("Pat on peer", "peer.test", True)
    ]

    for _ in range(federation.MISSES_PER_HOUR):
        remote_request(peer, "ZZZZZ-ZZZZZ")
    assert remote_request(peer, code).status_code == 429


def test_a_remote_friend_sees_only_what_is_shared(clients, peer, cards):  # noqa: F811
    connect(clients, peer)
    alice, alice_id = clients()
    own(alice, cards[1], 2, binder="Secret shoebox")
    alice.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[3], "notes": "private"}]})
    code = alice.post("/api/v1/friends/code", json={"action": "new"}).json()["code"]
    pat = uuid.uuid4()
    link = remote_request(peer, code, user_id=pat).json()["link_id"]
    assert peer.post("/friends/collection", {"link_id": link}).status_code == 404
    incoming = alice.get("/api/v1/friends").json()["incoming"][0]
    alice.post(f"/api/v1/friends/requests/{incoming['id']}/accept")

    shared = peer.post("/friends/collection", {"link_id": link}).json()
    assert shared["copies"] == 2 and shared["items"][0]["locations"] == []
    assert "Secret shoebox" not in json.dumps(shared)
    wishlist = peer.post("/friends/wishlist", {"link_id": link}).json()
    assert len(wishlist["items"]) == 1 and "private" not in json.dumps(wishlist)
    matches = peer.post("/friends/matches", {"link_id": link, "names": ["copper drake"]}).json()
    assert [(item["printing_id"], item["quantity"]) for item in matches["items"]] == [(cards[1], 2)]
    assert peer.post("/friends/collection", {"link_id": str(uuid.uuid4())}).status_code == 404

    alice.post(
        "/api/v1/friends/settings", json={"share_collection": False, "share_wishlist": False}
    )
    assert peer.received[-1] == (
        "/friends/sharing",
        {"user_id": str(alice_id), "share_collection": False, "share_wishlist": False},
    )
    assert peer.post("/friends/collection", {"link_id": link}).status_code == 403
    assert peer.post("/friends/wishlist", {"link_id": link}).status_code == 403
    assert (
        peer.post("/friends/matches", {"link_id": link, "names": ["copper drake"]}).json()["items"]
        == []
    )

    with session_factory()() as db, db.begin():
        db.execute(update(User).where(User.id == alice_id).values(suspended=True))
    assert peer.post("/friends/wishlist", {"link_id": link}).status_code == 404

    # Their side ending the friendship removes it here too.
    assert peer.post("/friends/removed", {"link_id": link}).status_code == 200
    with session_factory()() as db:
        assert (
            db.scalar(select(RemoteFriendship).where(RemoteFriendship.owner_id == alice_id)) is None
        )


def test_viewing_a_friend_on_another_server(clients, peer, cards):  # noqa: F811
    admin = connect(clients, peer)
    bob, bob_id = clients()
    own(bob, cards[3], 1)
    bob.post("/api/v1/wishlist", json={"items": [{"printing_id": cards[1]}]})
    pat = str(uuid.uuid4())

    peer.answers["/friend-requests"] = (404, {"detail": NOT_FOUND})
    missing = bob.post("/api/v1/friends/requests", json={"code": "ZZZZZ-ZZZZZ@" + PEER})
    assert missing.status_code == 404 and missing.json()["detail"] == NOT_FOUND
    elsewhere = bob.post("/api/v1/friends/requests", json={"code": "ZZZZZ-ZZZZZ@other.test"})
    assert elsewhere.status_code == 404 and "isn’t connected" in elsewhere.json()["detail"]

    peer.answers["/friend-requests"] = (
        200,
        lambda body: {
            "state": "accepted",
            "link_id": body["link_id"],
            "user": {"id": pat, "name": "Pat on peer"},
            "share_collection": True,
            "share_wishlist": True,
        },
    )
    sent = bob.post("/api/v1/friends/requests", json={"code": "ABCDE-23456@" + PEER})
    assert sent.json() == {"state": "accepted", "name": "Pat on peer"}
    path, asked = peer.received[-1]
    assert asked["code"] == "ABCDE23456"
    assert asked["user"] == {"id": str(bob_id), "name": "Test collector"}
    friend = bob.get("/api/v1/friends").json()["friends"][0]
    assert friend["server"] == "peer.test"
    base = f"/api/v1/friends/{friend['user_id']}"

    missing_card = str(uuid.uuid4())
    peer.answers["/friends/collection"] = (
        200,
        {
            "name": "Pat",
            "share_collection": True,
            "share_wishlist": True,
            "copies": 3,
            "cards": 2,
            "items": [
                {
                    "printing": {"id": cards[0], "image_url": "https://tracker.example/x.png"},
                    "quantity": 2,
                    "price_max": "999.00",
                    "finish_counts": {"foil": 1, "nonfoil": 1},
                    "locations": [{"name": "leak"}],
                },
                {"printing": {"id": missing_card}, "quantity": 1},
            ],
            "next_offset": None,
        },
    )
    collection = bob.get(base + "/collection").json()
    assert collection["name"] == "Pat" and collection["copies"] == 3
    # Cards are shown from this server's own catalog, never with the other server's links.
    assert [item["printing"]["id"] for item in collection["items"]] == [cards[0]]
    assert "tracker.example" not in json.dumps(collection) and "leak" not in json.dumps(collection)
    # Prices are this server's own, whatever the other server reported.
    owl = collection["items"][0]
    assert (owl["price_min"], owl["price_max"], owl["value"]) == ("2.0000", "6.0000", "8.0000")
    assert peer.received[-1][1]["provider"] == "tcgplayer"

    peer.answers["/friends/wishlist"] = (
        200,
        {
            "name": "Pat",
            "share_collection": True,
            "share_wishlist": True,
            "items": [{"id": "w1", "printing_id": cards[3], "finish": "any", "quantity": 2}],
        },
    )
    wishlist = bob.get(base + "/wishlist").json()
    assert [
        (item["printing"]["name"], item["owned"], item["unit_amount"]) for item in wishlist["items"]
    ] == [("Glass Tutor", 1, "40.00")]

    peer.answers["/friends/matches"] = (
        200,
        {
            "name": "Pat",
            "share_collection": True,
            "share_wishlist": True,
            "items": [{"printing_id": cards[1], "finish": "nonfoil", "quantity": 3}],
        },
    )
    matches = bob.get(base + "/matches").json()
    assert [item["printing"]["name"] for item in matches["they_have"]] == ["Copper Drake"]
    assert [item["printing"]["name"] for item in matches["you_have"]] == ["Glass Tutor"]
    asked = next(body for path, body in peer.received if path == "/friends/matches")
    assert asked["names"] == ["copper drake"]

    # Trade offers stay between people on the same server for now.
    offer = {"friend_id": friend["user_id"], "give": [], "get": [], "message": ""}
    assert (
        bob.post(
            "/api/v1/trade-offers", json=offer, headers={"Idempotency-Key": "k" * 16}
        ).status_code
        == 404
    )

    assert bob.delete(f"/api/v1/friends/{friend['id']}").status_code == 200
    assert peer.received[-1][0] == "/friends/removed"
    assert bob.get("/api/v1/friends").json()["friends"] == []

    # Ending the server connection ends friendships with people there.
    peer.answers["/friend-requests"] = (
        200,
        lambda body: {
            "state": "pending",
            "link_id": body["link_id"],
            "user": {"id": pat, "name": None},
        },
    )
    bob.post("/api/v1/friends/requests", json={"code": "ABCDE-23456@" + PEER})
    assert bob.get("/api/v1/friends").json()["outgoing"][0]["server"] == "peer.test"
    server = admin.get("/api/v1/servers").json()["servers"][0]
    admin.delete(f"/api/v1/servers/{server['id']}")
    assert bob.get("/api/v1/friends").json()["outgoing"] == []


def test_connect_requests_from_unknown_servers_are_throttled(clients, peer, monkeypatch):
    admin_of(clients)
    fetched = []
    real_fetch = federation.fetch_server
    monkeypatch.setattr(
        federation, "fetch_server", lambda url, timeout: fetched.append(url) or real_fetch(url)
    )
    assert peer.post("/connect", {"url": PEER}).json() == {"state": "pending"}
    # A known server signing with its key on file isn't looked up again.
    assert peer.post("/connect", {"url": PEER}).json() == {"state": "pending"}
    assert fetched == [PEER]
    with session_factory()() as db, db.begin():
        db.execute(delete(FederationPeer))
    # Stale requests stop before any lookup, and lookups are limited.
    stale = peer.post("/connect", {"url": PEER}, date=int(time.time()) - 3600)
    assert stale.status_code == 401 and fetched == [PEER]
    monkeypatch.setattr(federation, "DISCOVERIES_PER_MINUTE", 0)
    assert peer.post("/connect", {"url": PEER}).status_code == 429
    assert fetched == [PEER]
