"""Connections between PakTrak servers, so people on different servers can be friends.

A connection starts when an administrator enters another server's address. Both
servers' administrators must approve before anything else is exchanged. Every
request between servers is signed with the sending server's Ed25519 key and
checked against the key that server publishes at its own address, so a request
can't claim to come from a server that didn't send it.

Servers never list their accounts to each other. A friend request names a
private friend code, and a server answers a wrong code the same way whether or
not anyone has it. After two people accept, each server answers only for that
pair, and only with what its own person's sharing settings allow.
"""

import base64
import hashlib
import ipaddress
import json
import re
import secrets
import socket
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal
from urllib.parse import urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from scanner.account_access import account_name
from scanner.auth import DB, Admin
from scanner.models import (
    FederationNonce,
    FederationPeer,
    RemoteFriendship,
    ServerFederation,
    User,
    now,
)
from scanner.settings import get_settings

PROTOCOL = 1
PREFIX = "/api/federation/v1"
CLOCK_SKEW = 300
MAX_BODY = 64 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
TIMEOUT = 8.0
MAX_WAITING = 20
MISSES_PER_HOUR = 30
HOST = re.compile(
    r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
)

protocol = APIRouter(prefix=PREFIX, tags=["server connections"], include_in_schema=False)
admin = APIRouter(prefix="/api/v1/servers", tags=["server connections"])


class Unreachable(Exception):
    """The other server couldn't be reached or didn't answer like PakTrak."""


class Refused(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


# Keys and addresses


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def server_state(db, lock=False):
    """This server's key pair, created the first time it's needed."""
    query = select(ServerFederation).where(ServerFederation.id == 1)
    state = db.scalar(query.with_for_update() if lock else query)
    if state is None:
        private = Ed25519PrivateKey.generate()
        state = ServerFederation(
            id=1,
            enabled=False,
            private_key=b64(private.private_bytes_raw()),
            public_key=b64(private.public_key().public_bytes_raw()),
            created_at=now(),
        )
        db.add(state)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            state = db.scalar(query.with_for_update() if lock else query)
    return state


def enabled(db):
    return db.scalar(select(ServerFederation.enabled).where(ServerFederation.id == 1)) or False


def own_url():
    return get_settings().app_url


def host_of(url):
    return urlsplit(url).netloc


def clean_url(value):
    """A server address as an origin: https://host[:port], nothing after it."""
    value = value.strip()
    if "://" not in value:
        value = "https://" + value
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        parts, port = None, None
    allowed = {"https", "http"} if get_settings().allow_insecure_http else {"https"}
    host = (parts.hostname or "").rstrip(".") if parts else ""
    if (
        parts is None
        or parts.scheme not in allowed
        or parts.username
        or parts.password
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
        or not (HOST.match(host) or is_ip(host))
    ):
        raise HTTPException(
            422,
            "Enter the other server’s address, like https://cards.example.com."
            if get_settings().allow_insecure_http
            else "Enter the other server’s https:// address, like https://cards.example.com.",
        )
    default = 443 if parts.scheme == "https" else 80
    return f"{parts.scheme}://{host}" + (f":{port}" if port and port != default else "")


def is_ip(host):
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def check_address(url):
    """Refuse addresses on this server's own network unless the owner allows them."""
    if get_settings().federation_allow_private_addresses:
        return
    parts = urlsplit(url)
    try:
        found = socket.getaddrinfo(parts.hostname, parts.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise Unreachable(f"{parts.hostname} couldn’t be found.") from exc
    for *_, address in found:
        ip = ipaddress.ip_address(address[0].split("%")[0])
        if not ip.is_global:
            raise Unreachable(
                f"{parts.hostname} is on a private network. "
                "Set SCANNER_FEDERATION_ALLOW_PRIVATE_ADDRESSES=true to connect to it."
            )


# Signing


def signing_text(method, target, origin, date, nonce, body):
    return "\n".join(
        [
            "paktrak-federation-v1",
            method.upper(),
            target,
            origin,
            str(date),
            nonce,
            hashlib.sha256(body).hexdigest(),
        ]
    ).encode()


def signed_headers(private_key, target, body, origin=None):
    origin = origin or own_url()
    date, nonce = int(time.time()), secrets.token_urlsafe(24)
    key = Ed25519PrivateKey.from_private_bytes(unb64(private_key))
    signature = key.sign(signing_text("POST", target, origin, date, nonce, body))
    return {
        "Content-Type": "application/json",
        "User-Agent": "PakTrak federation/1",
        "PakTrak-Origin": origin,
        "PakTrak-Date": str(date),
        "PakTrak-Nonce": nonce,
        "PakTrak-Signature": b64(signature),
    }


def http_client(timeout=TIMEOUT):
    return httpx.Client(timeout=timeout, follow_redirects=False)


def read_json(response):
    data = b""
    for chunk in response.iter_bytes():
        data += chunk
        if len(data) > MAX_RESPONSE:
            raise Unreachable("The other server sent too much data.")
    try:
        return json.loads(data or b"{}")
    except ValueError as exc:
        raise Unreachable("The other server didn’t answer like PakTrak.") from exc


def describe(url):
    return f"Couldn’t reach {host_of(url)}. Check the address, or try again later."


def fetch_server(url):
    """The other server's published key, read from its own address."""
    check_address(url)
    try:
        with http_client() as client, client.stream("GET", url + PREFIX + "/server") as response:
            if response.status_code != 200:
                raise Unreachable(
                    f"{host_of(url)} isn’t accepting connections from other PakTrak servers."
                    if response.status_code == 404
                    else describe(url)
                )
            data = read_json(response)
    except httpx.HTTPError as exc:
        raise Unreachable(describe(url)) from exc
    try:
        info = ServerInfo.model_validate(data)
        Ed25519PublicKey.from_public_bytes(unb64(info.public_key))
    except (ValidationError, ValueError) as exc:
        raise Unreachable(f"{host_of(url)} didn’t answer like a PakTrak server.") from exc
    if info.url != url:
        raise Unreachable(
            f"{host_of(url)} says its address is {info.url}. Connect to that instead."
        )
    return info


def send(db, url, path, payload, timeout=TIMEOUT):
    """A signed request to another server. Returns its JSON answer."""
    check_address(url)
    body = json.dumps(payload, separators=(",", ":"), default=str).encode()
    target = url + PREFIX + path
    headers = signed_headers(server_state(db).private_key, target, body)
    try:
        with (
            http_client(timeout) as client,
            client.stream("POST", target, content=body, headers=headers) as response,
        ):
            data = read_json(response)
            status = response.status_code
    except httpx.HTTPError as exc:
        raise Unreachable(describe(url)) from exc
    if status >= 500 or status in {301, 302, 303, 307, 308}:
        raise Unreachable(describe(url))
    if status >= 400:
        detail = data.get("detail") if isinstance(data, dict) else None
        raise Refused(status, detail if isinstance(detail, str) else "")
    if not isinstance(data, dict):
        raise Unreachable(f"{host_of(url)} didn’t answer like a PakTrak server.")
    return data


def best_effort(db, url, path, payload):
    """For notices the other server can live without, like a friend being removed."""
    try:
        send(db, url, path, payload, timeout=4.0)
    except (Unreachable, Refused):
        pass


# Checking signed requests from other servers


@dataclass
class Signed:
    origin: str
    body: bytes


async def signed_body(request: Request):
    """Reads the body once, so the bytes checked are the bytes used."""
    length = request.headers.get("content-length") or "0"
    if not length.isdigit() or int(length) > MAX_BODY:
        raise HTTPException(413, "Request too large.")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY:
            raise HTTPException(413, "Request too large.")
    return Signed(origin=request.headers.get("paktrak-origin", ""), body=body)


def verify(db, request, signed, public_key):
    headers = request.headers
    try:
        date = int(headers.get("paktrak-date", ""))
        nonce = headers.get("paktrak-nonce", "")
        signature = unb64(headers.get("paktrak-signature", ""))
        key = Ed25519PublicKey.from_public_bytes(unb64(public_key))
    except ValueError as exc:
        raise HTTPException(401, "This request isn’t signed.") from exc
    if abs(time.time() - date) > CLOCK_SKEW:
        raise HTTPException(401, "This request’s time is off. Check both servers’ clocks.")
    if not 16 <= len(nonce) <= 64:
        raise HTTPException(401, "This request isn’t signed.")
    target = own_url() + request.url.path
    try:
        key.verify(
            signature, signing_text(request.method, target, signed.origin, date, nonce, signed.body)
        )
    except (InvalidSignature, ValueError) as exc:
        raise HTTPException(401, "This request’s signature doesn’t match.") from exc
    db.execute(
        delete(FederationNonce).where(FederationNonce.seen_at < now() - timedelta(minutes=15))
    )
    db.add(FederationNonce(nonce=nonce, seen_at=now()))
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(401, "This request was already received.") from exc


def require_enabled(db):
    if not enabled(db):
        raise HTTPException(404, "Not found.")


def from_peer(db, request, signed, connected=True):
    """The connected server that signed this request."""
    require_enabled(db)
    peer = db.scalar(
        select(FederationPeer).where(FederationPeer.url == signed.origin).with_for_update()
    )
    if peer is None or (connected and peer.state != "connected"):
        raise HTTPException(403, "This server isn’t connected.")
    verify(db, request, signed, peer.public_key)
    peer.last_seen_at = now()
    return peer


def parse(model, signed):
    try:
        return model.model_validate_json(signed.body or b"{}")
    except ValidationError as exc:
        raise HTTPException(422, "This request isn’t in the expected format.") from exc


class Strict(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ServerInfo(Strict):
    software: Literal["PakTrak"]
    protocol: int
    url: str = Field(max_length=255)
    public_key: str = Field(min_length=40, max_length=64)


class ConnectBody(Strict):
    url: str = Field(max_length=255)


class Person(Strict):
    id: uuid.UUID
    name: str = Field(min_length=1, max_length=255)


class FriendRequestBody(Strict):
    link_id: uuid.UUID
    code: str = Field(min_length=4, max_length=32)
    user: Person
    share_collection: bool
    share_wishlist: bool


class AcceptedBody(Strict):
    link_id: uuid.UUID
    user: Person
    share_collection: bool
    share_wishlist: bool


class LinkBody(Strict):
    link_id: uuid.UUID


class SharingBody(Strict):
    user_id: uuid.UUID
    share_collection: bool
    share_wishlist: bool


class CollectionBody(Strict):
    link_id: uuid.UUID
    offset: int = Field(0, ge=0, le=1_000_000)
    q: str = Field("", max_length=255)
    sort: Literal["name", "price_desc", "price_asc", "newest"] = "name"
    provider: Literal["tcgplayer", "cardkingdom", "manapool"] = "tcgplayer"


class MatchesBody(Strict):
    link_id: uuid.UUID
    names: list[str] = Field(default_factory=list, max_length=5000)


# What this server answers


@protocol.get("/server")
def server_info(db: DB):
    require_enabled(db)
    return {
        "software": "PakTrak",
        "protocol": PROTOCOL,
        "url": own_url(),
        "public_key": server_state(db).public_key,
    }


@protocol.post("/connect")
def connect_request(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    """Another server asks to connect. This server's admin approves it, unless they asked first."""
    require_enabled(db)
    data = parse(ConnectBody, signed)
    if data.url != signed.origin or data.url == own_url():
        raise HTTPException(422, "The server address doesn’t match the request.")
    try:
        url = clean_url(data.url)
    except HTTPException as exc:
        raise HTTPException(422, "The server address isn’t valid.") from exc
    if url != data.url:
        raise HTTPException(422, "The server address isn’t valid.")
    peer = db.scalar(select(FederationPeer).where(FederationPeer.url == url).with_for_update())
    if peer is None:
        waiting = db.scalar(
            select(func.count())
            .select_from(FederationPeer)
            .where(FederationPeer.state == "pending")
        )
        if waiting >= MAX_WAITING:
            raise HTTPException(429, "This server has too many connection requests waiting.")
    # Their published key, read from their own address, must have signed this request.
    try:
        info = fetch_server(url)
    except Unreachable as exc:
        raise HTTPException(422, str(exc)) from exc
    if peer is not None and peer.public_key != info.public_key and peer.state == "connected":
        raise HTTPException(
            409, "This server knows a different key for your server. Ask its admin to reconnect."
        )
    verify(db, request, signed, info.public_key)
    if peer is None:
        peer = FederationPeer(url=url, state="pending", misses=0, created_at=now())
        db.add(peer)
    elif peer.state == "requested":
        # This server's admin already asked them, so both sides have now approved.
        peer.state, peer.connected_at = "connected", now()
    peer.public_key, peer.last_seen_at = info.public_key, now()
    db.commit()
    return {"state": "connected" if peer.state == "connected" else "pending"}


@protocol.post("/accept")
def connect_accepted(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    """Their admin approved a connection this server's admin asked for."""
    peer = from_peer(db, request, signed, connected=False)
    if peer.state == "pending":
        raise HTTPException(409, "This server hasn’t asked to connect.")
    if peer.state == "requested":
        peer.state, peer.connected_at = "connected", now()
    db.commit()
    return {"state": "connected"}


@protocol.post("/disconnect")
def disconnected(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    peer = from_peer(db, request, signed, connected=False)
    db.delete(peer)
    db.commit()
    return {"state": "disconnected"}


def answer_for(link, user):
    return {
        "state": link.state,
        "link_id": str(link.link_id),
        "user": {"id": str(user.id), "name": account_name(user)}
        if link.state == "accepted"
        else {"id": str(user.id), "name": None},
        "share_collection": user.share_collection if link.state == "accepted" else False,
        "share_wishlist": user.share_wishlist if link.state == "accepted" else False,
    }


@protocol.post("/friend-requests")
def remote_friend_request(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    from scanner.social import NOT_FOUND, clean_code

    peer = from_peer(db, request, signed)
    data = parse(FriendRequestBody, signed)
    if peer.misses_since is None or peer.misses_since < now() - timedelta(hours=1):
        peer.misses, peer.misses_since = 0, now()
    if peer.misses >= MISSES_PER_HOUR:
        db.commit()
        raise HTTPException(429, "Too many codes didn’t match. Wait an hour, then try again.")
    code = clean_code(data.code)
    person = db.scalar(select(User).where(User.friend_code == code)) if code else None
    if person is None or person.suspended:
        peer.misses += 1
        db.commit()
        raise HTTPException(404, NOT_FOUND)
    link = db.scalar(
        select(RemoteFriendship)
        .where(
            RemoteFriendship.owner_id == person.id,
            RemoteFriendship.peer_id == peer.id,
            RemoteFriendship.remote_user == data.user.id,
        )
        .with_for_update()
    )
    if link is None:
        link = RemoteFriendship(
            owner_id=person.id,
            peer_id=peer.id,
            link_id=data.link_id,
            remote_user=data.user.id,
            sent_by_owner=False,
            state="pending",
            created_at=now(),
        )
        db.add(link)
    elif link.state == "pending" and link.sent_by_owner:
        # This person already asked them; their code answers yes.
        link.state, link.accepted_at = "accepted", now()
    link.remote_name = data.user.name
    link.shares_collection, link.shares_wishlist = data.share_collection, data.share_wishlist
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "This request can’t be sent again. Try once more.") from exc
    return answer_for(link, person)


def peer_link(db, peer, link_id, state=None, lock=False):
    query = select(RemoteFriendship).where(
        RemoteFriendship.peer_id == peer.id, RemoteFriendship.link_id == link_id
    )
    link = db.scalar(query.with_for_update() if lock else query)
    if link is None or (state and link.state != state):
        raise HTTPException(404, "This friend is no longer connected.")
    return link


@protocol.post("/friends/accepted")
def remote_accepted(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    peer = from_peer(db, request, signed)
    data = parse(AcceptedBody, signed)
    link = peer_link(db, peer, data.link_id, lock=True)
    if not link.sent_by_owner or link.remote_user not in (None, data.user.id):
        raise HTTPException(404, "This friend request is no longer waiting.")
    if link.state == "pending":
        link.state, link.accepted_at = "accepted", now()
    link.remote_user, link.remote_name = data.user.id, data.user.name
    link.shares_collection, link.shares_wishlist = data.share_collection, data.share_wishlist
    db.commit()
    return {"state": "accepted"}


@protocol.post("/friends/removed")
def remote_removed(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    peer = from_peer(db, request, signed)
    data = parse(LinkBody, signed)
    db.execute(
        delete(RemoteFriendship).where(
            RemoteFriendship.peer_id == peer.id, RemoteFriendship.link_id == data.link_id
        )
    )
    db.commit()
    return {"removed": True}


@protocol.post("/friends/sharing")
def remote_sharing(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    peer = from_peer(db, request, signed)
    data = parse(SharingBody, signed)
    for link in db.scalars(
        select(RemoteFriendship).where(
            RemoteFriendship.peer_id == peer.id,
            RemoteFriendship.remote_user == data.user_id,
            RemoteFriendship.state == "accepted",
        )
    ):
        link.shares_collection, link.shares_wishlist = data.share_collection, data.share_wishlist
    db.commit()
    return {"updated": True}


def shared_person(db, peer, link_id):
    """This server's person in an accepted link, while their account is active."""
    link = peer_link(db, peer, link_id, state="accepted")
    person = db.get(User, link.owner_id)
    if person is None or person.suspended:
        raise HTTPException(404, "This friend is no longer connected.")
    return person


def sharing(person):
    return {
        "name": account_name(person),
        "share_collection": person.share_collection,
        "share_wishlist": person.share_wishlist,
    }


@protocol.post("/friends/collection")
def remote_collection(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    from scanner.gallery import collection_cards

    peer = from_peer(db, request, signed)
    data = parse(CollectionBody, signed)
    person = shared_person(db, peer, data.link_id)
    db.commit()
    if not person.share_collection:
        raise HTTPException(403, f"{account_name(person)} isn’t sharing their collection.")
    result = collection_cards(
        db,
        person.id,
        offset=data.offset,
        binder_id=None,
        q=data.q,
        provider=data.provider,
        color="",
        rarity="",
        card_type="",
        set_code="",
        finish="",
        sort=data.sort,
        seed="",
    )
    # Storage locations and notes stay private to the owner.
    for item in result["items"]:
        item["locations"], item["location_count"] = [], 0
    return {**sharing(person), **result}


@protocol.post("/friends/wishlist")
def remote_wishlist(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    from scanner.models import WishlistItem

    peer = from_peer(db, request, signed)
    data = parse(LinkBody, signed)
    person = shared_person(db, peer, data.link_id)
    db.commit()
    if not person.share_wishlist:
        raise HTTPException(403, f"{account_name(person)} isn’t sharing their wishlist.")
    items = db.scalars(
        select(WishlistItem).where(WishlistItem.owner_id == person.id).order_by(WishlistItem.id)
    ).all()
    return {
        **sharing(person),
        # Notes stay private to the owner.
        "items": [
            {
                "id": str(item.id),
                "printing_id": str(item.printing_id),
                "finish": item.finish,
                "quantity": item.quantity,
                "created_at": item.created_at,
            }
            for item in items
        ],
    }


@protocol.post("/friends/matches")
def remote_matches(request: Request, db: DB, signed: Signed = Depends(signed_body)):
    """Copies this server's person owns of the card names their friend wants."""
    from scanner.social import holdings_named

    peer = from_peer(db, request, signed)
    data = parse(MatchesBody, signed)
    person = shared_person(db, peer, data.link_id)
    db.commit()
    rows = (
        holdings_named(db, person.id, {name.lower() for name in data.names})
        if person.share_collection
        else []
    )
    return {
        **sharing(person),
        "items": [
            {"printing_id": str(printing.id), "finish": finish, "quantity": quantity}
            for printing, finish, quantity in rows
        ],
    }


# Server connections, for administrators


class ServerAddress(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=3, max_length=255)


class FederationSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)


def servers_json(db):
    state = server_state(db)
    friends = dict(
        db.execute(
            select(RemoteFriendship.peer_id, func.count())
            .where(RemoteFriendship.state == "accepted")
            .group_by(RemoteFriendship.peer_id)
        ).all()
    )
    peers = db.scalars(select(FederationPeer).order_by(FederationPeer.url)).all()
    db.commit()
    return {
        "enabled": state.enabled,
        "address": own_url(),
        "secure": own_url().startswith("https://"),
        "servers": [
            {
                "id": str(peer.id),
                "url": peer.url,
                "host": host_of(peer.url),
                "state": peer.state,
                "created_at": peer.created_at,
                "connected_at": peer.connected_at,
                "last_seen_at": peer.last_seen_at,
                "friendships": friends.get(peer.id, 0),
            }
            for peer in peers
        ],
    }


def admin_peer(db, peer_id):
    peer = db.scalar(select(FederationPeer).where(FederationPeer.id == peer_id).with_for_update())
    if peer is None:
        raise HTTPException(404, "This server connection is gone. Refresh to see the list.")
    return peer


def unreachable(exc):
    # A JSON 503, which the web app shows as this message; a 502 would read as this server down.
    return HTTPException(503, str(exc))


def refused(url, exc):
    return HTTPException(
        409,
        exc.detail or f"{host_of(url)} turned down the request.",
    )


@admin.get("")
def list_servers(_: Admin, db: DB):
    return servers_json(db)


@admin.post("/settings")
def change_setting(data: FederationSetting, _: Admin, db: DB):
    state = server_state(db, lock=True)
    state.enabled = data.enabled
    db.commit()
    return servers_json(db)


@admin.post("")
def add_server(data: ServerAddress, _: Admin, db: DB):
    if not enabled(db):
        raise HTTPException(409, "Turn on connections with other servers first.")
    url = clean_url(data.url)
    if url == own_url():
        raise HTTPException(422, "That’s this server’s own address.")
    peer = db.scalar(select(FederationPeer).where(FederationPeer.url == url))
    if peer is not None and peer.state == "pending":
        return approve_server(peer.id, _, db)
    if peer is not None and peer.state == "connected":
        raise HTTPException(409, f"{host_of(url)} is already connected.")
    db.commit()
    try:
        info = fetch_server(url)
    except Unreachable as exc:
        raise unreachable(exc) from exc
    peer = db.scalar(select(FederationPeer).where(FederationPeer.url == url).with_for_update())
    if peer is None:
        peer = FederationPeer(url=url, state="requested", misses=0, created_at=now())
        db.add(peer)
    peer.public_key = info.public_key
    db.commit()
    try:
        answer = send(db, url, "/connect", {"url": own_url()})
    except Unreachable as exc:
        raise unreachable(exc) from exc
    except Refused as exc:
        raise refused(url, exc) from exc
    peer = admin_peer(db, peer.id)
    if answer.get("state") == "connected" and peer.state != "connected":
        peer.state, peer.connected_at = "connected", now()
    db.commit()
    return servers_json(db)


@admin.post("/{peer_id}/approve")
def approve_server(peer_id: uuid.UUID, _: Admin, db: DB):
    if not enabled(db):
        raise HTTPException(409, "Turn on connections with other servers first.")
    peer = admin_peer(db, peer_id)
    if peer.state != "pending":
        db.commit()
        return servers_json(db)
    url = peer.url
    db.commit()
    try:
        send(db, url, "/accept", {})
    except Unreachable as exc:
        raise unreachable(exc) from exc
    except Refused as exc:
        raise refused(url, exc) from exc
    peer = admin_peer(db, peer_id)
    peer.state, peer.connected_at = "connected", now()
    db.commit()
    return servers_json(db)


@admin.delete("/{peer_id}")
def remove_server(peer_id: uuid.UUID, _: Admin, db: DB):
    """Declines, cancels or ends a connection. Friendships with people there end too."""
    peer = admin_peer(db, peer_id)
    url = peer.url
    db.delete(peer)
    db.commit()
    if enabled(db):
        best_effort(db, url, "/disconnect", {})
    return servers_json(db)


# Friends on other servers, as seen by this server's people


def split_code(value):
    """ABCDE-23456@cards.example.com names a code on another server."""
    code, at, server = value.strip().rpartition("@")
    return (code, server) if at else (value, None)


def connected_peer(db, server):
    url = clean_url(server)
    peer = db.scalar(
        select(FederationPeer).where(FederationPeer.url == url, FederationPeer.state == "connected")
    )
    if peer is None or not enabled(db):
        raise HTTPException(
            404,
            f"{host_of(url)} isn’t connected to this PakTrak. "
            "Ask your administrator to connect the two servers.",
        )
    return peer


def request_remote_friend(db, me, code, server):
    """Send a friend request to someone on another server. Returns social's answer."""
    from scanner.social import NOT_FOUND

    peer = connected_peer(db, server)
    url, peer_id = peer.url, peer.id
    link_id = uuid.uuid4()
    payload = {
        "link_id": str(link_id),
        "code": code,
        "user": {"id": str(me.id), "name": account_name(me)},
        "share_collection": me.share_collection,
        "share_wishlist": me.share_wishlist,
    }
    db.commit()
    try:
        answer = send(db, url, "/friend-requests", payload)
    except Unreachable as exc:
        raise unreachable(exc) from exc
    except Refused as exc:
        if exc.status == 404:
            return None
        if exc.status == 429:
            raise HTTPException(429, NOT_FOUND if not exc.detail else exc.detail) from exc
        raise refused(url, exc) from exc
    try:
        answer = Answer.model_validate(answer)
    except ValidationError as exc:
        raise HTTPException(503, f"{host_of(url)} didn’t answer like PakTrak.") from exc
    link = db.scalar(
        select(RemoteFriendship)
        .where(RemoteFriendship.peer_id == peer_id, RemoteFriendship.link_id == answer.link_id)
        .with_for_update()
    )
    if link is None:
        link = db.scalar(
            select(RemoteFriendship)
            .where(
                RemoteFriendship.owner_id == me.id,
                RemoteFriendship.peer_id == peer_id,
                RemoteFriendship.remote_user == answer.user.id,
            )
            .with_for_update()
        )
    if link is None:
        link = RemoteFriendship(
            owner_id=me.id,
            peer_id=peer_id,
            link_id=answer.link_id,
            sent_by_owner=True,
            state="pending",
            created_at=now(),
        )
        db.add(link)
    elif link.owner_id != me.id:
        raise HTTPException(503, f"{host_of(url)} didn’t answer like PakTrak.")
    link.remote_user = answer.user.id
    if answer.state == "accepted":
        link.state, link.accepted_at = "accepted", link.accepted_at or now()
        link.remote_name = answer.user.name
        link.shares_collection = answer.share_collection
        link.shares_wishlist = answer.share_wishlist
    db.commit()
    return {"state": link.state, "name": link.remote_name if link.state == "accepted" else None}


class AnswerPerson(Strict):
    id: uuid.UUID
    name: str | None = Field(default=None, max_length=255)


class Answer(Strict):
    state: Literal["pending", "accepted"]
    link_id: uuid.UUID
    user: AnswerPerson
    share_collection: bool = False
    share_wishlist: bool = False


def remote_links(db, owner_id):
    """This person's friends and requests on connected servers."""
    if not enabled(db):
        return []
    return db.execute(
        select(RemoteFriendship, FederationPeer)
        .join(FederationPeer)
        .where(RemoteFriendship.owner_id == owner_id, FederationPeer.state == "connected")
        .order_by(RemoteFriendship.created_at)
    ).all()


def remote_link(db, owner_id, link_id, state=None, lock=False):
    """One of this person's remote links by its local ID, or None."""
    if not enabled(db):
        return None
    query = (
        select(RemoteFriendship, FederationPeer)
        .join(FederationPeer)
        .where(
            RemoteFriendship.id == link_id,
            RemoteFriendship.owner_id == owner_id,
            FederationPeer.state == "connected",
        )
    )
    row = db.execute(query.with_for_update(of=RemoteFriendship) if lock else query).first()
    if row is None or (state and row[0].state != state):
        return None
    return row


def accept_remote(db, me, link, peer):
    payload = {
        "link_id": str(link.link_id),
        "user": {"id": str(me.id), "name": account_name(me)},
        "share_collection": me.share_collection,
        "share_wishlist": me.share_wishlist,
    }
    link_id, url = link.id, peer.url
    db.commit()
    try:
        send(db, url, "/friends/accepted", payload)
    except Unreachable as exc:
        raise unreachable(exc) from exc
    except Refused as exc:
        if exc.status == 404:
            db.execute(delete(RemoteFriendship).where(RemoteFriendship.id == link_id))
            db.commit()
            raise HTTPException(404, "This friend request is no longer waiting.") from exc
        raise refused(url, exc) from exc
    row = remote_link(db, me.id, link_id, lock=True)
    if row is None:
        raise HTTPException(404, "This friend request is no longer waiting.")
    row[0].state, row[0].accepted_at = "accepted", now()
    db.commit()


def drop_remote(db, link, peer):
    """Removing a friend, declining or withdrawing a request; the other server is told."""
    url, link_id = peer.url, str(link.link_id)
    db.delete(link)
    db.commit()
    best_effort(db, url, "/friends/removed", {"link_id": link_id})


def share_changed(db, me):
    """Tell connected servers where this person has friends that their sharing changed."""
    if not enabled(db):
        return
    urls = db.scalars(
        select(FederationPeer.url)
        .join(RemoteFriendship)
        .where(
            RemoteFriendship.owner_id == me.id,
            RemoteFriendship.state == "accepted",
            FederationPeer.state == "connected",
        )
        .distinct()
    ).all()
    payload = {
        "user_id": str(me.id),
        "share_collection": me.share_collection,
        "share_wishlist": me.share_wishlist,
    }
    for url in urls:
        best_effort(db, url, "/friends/sharing", payload)


def ask(db, link, peer, path, payload):
    """Ask a friend's server for something, keeping their name and sharing up to date."""
    url, link_pk = peer.url, link.id
    db.commit()
    try:
        answer = send(db, url, path, {"link_id": str(link.link_id), **payload})
    except Unreachable as exc:
        raise unreachable(exc) from exc
    except Refused as exc:
        if exc.status == 404:
            db.execute(delete(RemoteFriendship).where(RemoteFriendship.id == link_pk))
            db.commit()
            raise HTTPException(404, "This friend is no longer connected.") from exc
        if exc.status == 403:
            raise HTTPException(403, exc.detail or "They aren’t sharing this.") from exc
        raise refused(url, exc) from exc
    name = answer.get("name")
    fresh = db.get(RemoteFriendship, link_pk)
    if fresh is not None:
        if isinstance(name, str) and 0 < len(name) <= 255:
            fresh.remote_name = name
        for field in ("share_collection", "share_wishlist"):
            if isinstance(answer.get(field), bool):
                setattr(fresh, "shares_" + field.removeprefix("share_"), answer[field])
        db.commit()
    return answer
